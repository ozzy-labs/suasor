import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../../src/db/index.ts";
import { taskCreate } from "../../src/propose/task-create.ts";
import { taskUpdate } from "../../src/propose/task-update.ts";

let store: Store;

beforeEach(() => {
  store = Store.open({ path: ":memory:" });
});

afterEach(() => {
  store.close();
});

function stateOf(taskId: string): string | undefined {
  const row = store.connection.sqlite.query("SELECT state FROM tasks WHERE id = ?").get(taskId) as {
    state: string;
  } | null;
  return row?.state;
}

describe("task.update (direct HITL task lifecycle transition)", () => {
  test("transitions a task's state and appends TaskApplied", () => {
    const { taskId } = taskCreate(store, { title: "ship it" });
    expect(stateOf(taskId)).toBe("proposed");

    const out = taskUpdate(store, { taskId, state: "in_progress" });
    expect(out.status).toBe("updated");
    expect(out.state).toBe("in_progress");
    expect(stateOf(taskId)).toBe("in_progress");

    const done = taskUpdate(store, { taskId, state: "completed" });
    expect(done.status).toBe("updated");
    expect(stateOf(taskId)).toBe("completed");
  });

  test("same-state transition is an idempotent no-op (unchanged, no event)", () => {
    const { taskId } = taskCreate(store, { title: "dup" });
    taskUpdate(store, { taskId, state: "completed" });
    const eventsBefore = store.connection.sqlite
      .query("SELECT count(*) AS n FROM events")
      .get() as { n: number };

    const again = taskUpdate(store, { taskId, state: "completed" });
    expect(again.status).toBe("unchanged");
    const eventsAfter = store.connection.sqlite.query("SELECT count(*) AS n FROM events").get() as {
      n: number;
    };
    expect(eventsAfter.n).toBe(eventsBefore.n);
  });

  test("reports missing for an unknown task (no throw, no event)", () => {
    const out = taskUpdate(store, { taskId: "task_does_not_exist", state: "completed" });
    expect(out.status).toBe("missing");
    expect(out.state).toBeNull();
  });

  test("allows reopening a terminal state (completed → in_progress)", () => {
    const { taskId } = taskCreate(store, { title: "reopen me" });
    taskUpdate(store, { taskId, state: "completed" });
    const out = taskUpdate(store, { taskId, state: "in_progress" });
    expect(out.status).toBe("updated");
    expect(stateOf(taskId)).toBe("in_progress");
  });

  test("rejects an invalid state value", () => {
    const { taskId } = taskCreate(store, { title: "bad state" });
    // @ts-expect-error invalid state is rejected by the Zod enum at runtime
    expect(() => taskUpdate(store, { taskId, state: "archived" })).toThrow();
  });

  describe("scheduling fields (ADR-0028)", () => {
    function schedulingOf(taskId: string) {
      return store.connection.sqlite
        .query("SELECT due_date, priority FROM tasks WHERE id = ?")
        .get(taskId) as { due_date: string | null; priority: string | null } | null;
    }

    test("a non-null dueDate / priority (re)sets them even when state is unchanged", () => {
      const { taskId } = taskCreate(store, { title: "set due later" });
      taskUpdate(store, { taskId, state: "open" });
      // Same state but a scheduling update → not a no-op.
      const out = taskUpdate(store, {
        taskId,
        state: "open",
        dueDate: "2026-07-01T00:00:00.000Z",
        priority: "high",
      });
      expect(out.status).toBe("updated");
      expect(schedulingOf(taskId)).toEqual({
        due_date: "2026-07-01T00:00:00.000Z",
        priority: "high",
      });
    });

    test("null scheduling on a state transition leaves an existing due date untouched", () => {
      const { taskId } = taskCreate(store, {
        title: "keep due",
        dueDate: "2026-07-01T00:00:00.000Z",
        priority: "normal",
      });
      taskUpdate(store, { taskId, state: "in_progress" });
      expect(schedulingOf(taskId)).toEqual({
        due_date: "2026-07-01T00:00:00.000Z",
        priority: "normal",
      });
    });

    test("same-state with no scheduling update stays an unchanged no-op", () => {
      const { taskId } = taskCreate(store, { title: "noop" });
      taskUpdate(store, { taskId, state: "completed" });
      const before = store.connection.sqlite.query("SELECT count(*) AS n FROM events").get() as {
        n: number;
      };
      const again = taskUpdate(store, { taskId, state: "completed" });
      expect(again.status).toBe("unchanged");
      const after = store.connection.sqlite.query("SELECT count(*) AS n FROM events").get() as {
        n: number;
      };
      expect(after.n).toBe(before.n);
    });

    test("rejects an invalid priority value", () => {
      const { taskId } = taskCreate(store, { title: "bad priority" });
      expect(() =>
        // @ts-expect-error invalid priority is rejected by the Zod enum at runtime
        taskUpdate(store, { taskId, state: "open", priority: "urgent" }),
      ).toThrow();
    });
  });
});
