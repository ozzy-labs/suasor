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
  test("transitions a task's state and appends TaskApplied", async () => {
    const { taskId } = taskCreate(store, { title: "ship it" });
    expect(stateOf(taskId)).toBe("proposed");

    const out = await taskUpdate(store, { taskId, state: "in_progress" });
    expect(out.status).toBe("updated");
    expect(out.state).toBe("in_progress");
    expect(stateOf(taskId)).toBe("in_progress");

    const done = await taskUpdate(store, { taskId, state: "completed" });
    expect(done.status).toBe("updated");
    expect(stateOf(taskId)).toBe("completed");
  });

  test("same-state transition is an idempotent no-op (unchanged, no event)", async () => {
    const { taskId } = taskCreate(store, { title: "dup" });
    await taskUpdate(store, { taskId, state: "completed" });
    const eventsBefore = store.connection.sqlite
      .query("SELECT count(*) AS n FROM events")
      .get() as { n: number };

    const again = await taskUpdate(store, { taskId, state: "completed" });
    expect(again.status).toBe("unchanged");
    const eventsAfter = store.connection.sqlite.query("SELECT count(*) AS n FROM events").get() as {
      n: number;
    };
    expect(eventsAfter.n).toBe(eventsBefore.n);
  });

  test("reports missing for an unknown task (no throw, no event)", async () => {
    const out = await taskUpdate(store, { taskId: "task_does_not_exist", state: "completed" });
    expect(out.status).toBe("missing");
    expect(out.state).toBeNull();
  });

  test("allows reopening a terminal state (completed → in_progress)", async () => {
    const { taskId } = taskCreate(store, { title: "reopen me" });
    await taskUpdate(store, { taskId, state: "completed" });
    const out = await taskUpdate(store, { taskId, state: "in_progress" });
    expect(out.status).toBe("updated");
    expect(stateOf(taskId)).toBe("in_progress");
  });

  test("rejects an invalid state value", async () => {
    const { taskId } = taskCreate(store, { title: "bad state" });
    // @ts-expect-error invalid state is rejected by the Zod enum at runtime
    await expect(taskUpdate(store, { taskId, state: "archived" })).rejects.toThrow();
  });

  describe("scheduling fields (ADR-0028)", () => {
    function schedulingOf(taskId: string) {
      return store.connection.sqlite
        .query("SELECT due_date, priority FROM tasks WHERE id = ?")
        .get(taskId) as { due_date: string | null; priority: string | null } | null;
    }

    test("a non-null dueDate / priority (re)sets them even when state is unchanged", async () => {
      const { taskId } = taskCreate(store, { title: "set due later" });
      await taskUpdate(store, { taskId, state: "open" });
      // Same state but a scheduling update → not a no-op.
      const out = await taskUpdate(store, {
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

    test("null scheduling on a state transition leaves an existing due date untouched", async () => {
      const { taskId } = taskCreate(store, {
        title: "keep due",
        dueDate: "2026-07-01T00:00:00.000Z",
        priority: "normal",
      });
      await taskUpdate(store, { taskId, state: "in_progress" });
      expect(schedulingOf(taskId)).toEqual({
        due_date: "2026-07-01T00:00:00.000Z",
        priority: "normal",
      });
    });

    test("same-state with no scheduling update stays an unchanged no-op", async () => {
      const { taskId } = taskCreate(store, { title: "noop" });
      await taskUpdate(store, { taskId, state: "completed" });
      const before = store.connection.sqlite.query("SELECT count(*) AS n FROM events").get() as {
        n: number;
      };
      const again = await taskUpdate(store, { taskId, state: "completed" });
      expect(again.status).toBe("unchanged");
      const after = store.connection.sqlite.query("SELECT count(*) AS n FROM events").get() as {
        n: number;
      };
      expect(after.n).toBe(before.n);
    });

    test("rejects an invalid priority value", async () => {
      const { taskId } = taskCreate(store, { title: "bad priority" });
      await expect(
        // @ts-expect-error invalid priority is rejected by the Zod enum at runtime
        taskUpdate(store, { taskId, state: "open", priority: "urgent" }),
      ).rejects.toThrow();
    });
  });

  describe("published task routing through the actuator (ADR-0036 §3)", () => {
    const config = {
      tasks: {
        home: { destination: "github" as const, repo: "acme/widgets" },
        slackListExcludeFromIngest: true,
      },
    };

    function publish(taskId: string, externalId: string) {
      store.record({
        type: "TaskPublished",
        taskId,
        destination: "github",
        externalId,
        publishedAt: "2026-06-23T00:00:00+00:00",
      });
    }

    /** Fake actuator + injectable loader recording act() calls. */
    function fakeActuator() {
      const acts: Array<{ externalId: string; kind: string }> = [];
      const loader = async () => ({
        destination: "github" as const,
        async publish() {
          return { externalId: "gh:acme/widgets:issue:1" };
        },
        async act(externalId: string, action: { kind: string }) {
          acts.push({ externalId, kind: action.kind });
        },
      });
      return { loader, acts };
    }

    test("completed on a published task issues actuator complete, then caches TaskApplied", async () => {
      const { taskId } = taskCreate(store, { title: "ship" });
      publish(taskId, "gh:acme/widgets:issue:7");
      const fake = fakeActuator();

      const out = await taskUpdate(store, { taskId, state: "completed" }, new Date(), {
        config,
        loadActuatorImpl: fake.loader,
      });

      expect(out.status).toBe("updated");
      expect(fake.acts).toEqual([{ externalId: "gh:acme/widgets:issue:7", kind: "complete" }]);
      expect(stateOf(taskId)).toBe("completed"); // optimistic local cache
    });

    test("open on a published task maps to actuator reopen", async () => {
      const { taskId } = taskCreate(store, { title: "reopen" });
      publish(taskId, "gh:acme/widgets:issue:7");
      const fake = fakeActuator();
      await taskUpdate(store, { taskId, state: "completed" }, new Date(), {
        config,
        loadActuatorImpl: fake.loader,
      });
      fake.acts.length = 0; // clear the setup transition
      await taskUpdate(store, { taskId, state: "open" }, new Date(), {
        config,
        loadActuatorImpl: fake.loader,
      });
      expect(fake.acts[0]?.kind).toBe("reopen");
    });

    test("dropped on a published task issues actuator drop, then caches dropped", async () => {
      const { taskId } = taskCreate(store, { title: "drop" });
      publish(taskId, "gh:acme/widgets:issue:7");
      const fake = fakeActuator();
      const out = await taskUpdate(store, { taskId, state: "dropped" }, new Date(), {
        config,
        loadActuatorImpl: fake.loader,
      });
      expect(out.status).toBe("updated");
      expect(fake.acts).toEqual([{ externalId: "gh:acme/widgets:issue:7", kind: "drop" }]);
      expect(stateOf(taskId)).toBe("dropped"); // optimistic local cache
    });

    test("an unpublished task stays local-only (no actuator call)", async () => {
      const { taskId } = taskCreate(store, { title: "local" });
      const fake = fakeActuator();
      await taskUpdate(store, { taskId, state: "completed" }, new Date(), {
        config,
        loadActuatorImpl: fake.loader,
      });
      expect(fake.acts).toHaveLength(0);
      expect(stateOf(taskId)).toBe("completed");
    });

    test("same-state no-op on a published task never reaches the actuator", async () => {
      const { taskId } = taskCreate(store, { title: "noop" });
      publish(taskId, "gh:acme/widgets:issue:7");
      const fake = fakeActuator();
      await taskUpdate(store, { taskId, state: "completed" }, new Date(), {
        config,
        loadActuatorImpl: fake.loader,
      });
      fake.acts.length = 0; // clear the setup transition
      const again = await taskUpdate(store, { taskId, state: "completed" }, new Date(), {
        config,
        loadActuatorImpl: fake.loader,
      });
      expect(again.status).toBe("unchanged");
      expect(fake.acts).toHaveLength(0);
    });
  });
});
