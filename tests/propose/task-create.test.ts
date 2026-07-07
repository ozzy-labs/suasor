import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../../src/db/index.ts";
import { taskCreate } from "../../src/propose/task-create.ts";

let store: Store;

beforeEach(() => {
  store = Store.open({ path: ":memory:" });
});

afterEach(() => {
  store.close();
});

function tasks() {
  return store.connection.sqlite.query("SELECT id, title, state FROM tasks").all() as Array<{
    id: string;
    title: string;
    state: string;
  }>;
}

describe("task.create (direct HITL task creation, #12 追補 D2)", () => {
  test("appends TaskProposed → tasks projection (state: proposed)", () => {
    const out = taskCreate(store, { title: "write the report" });
    expect(out.status).toBe("created");
    const rows = tasks();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("write the report");
    expect(rows[0]?.state).toBe("proposed");
    expect(rows[0]?.id).toBe(out.taskId);
  });

  test("records provenance links to source ids", () => {
    taskCreate(store, { title: "follow up", sourceExternalIds: ["gh:1", "gh:2"] });
    const links = store.connection.sqlite
      .query("SELECT to_id FROM links WHERE from_kind = 'task' AND relation = 'derived_from'")
      .all() as Array<{ to_id: string }>;
    expect(links.map((l) => l.to_id).sort()).toEqual(["gh:1", "gh:2"]);
  });

  test("is idempotent on content: re-creating the same task is a no-op", () => {
    const first = taskCreate(store, { title: "dup", sourceExternalIds: ["gh:1"] });
    expect(first.status).toBe("created");
    const second = taskCreate(store, { title: "dup", sourceExternalIds: ["gh:1"] });
    expect(second.status).toBe("existing");
    expect(second.taskId).toBe(first.taskId);
    expect(tasks()).toHaveLength(1);
  });

  test("rejects an empty title", () => {
    expect(() => taskCreate(store, { title: "" })).toThrow();
  });

  describe("recurring titles ([boundary/propose-1], #435)", () => {
    /** Drive a task to a terminal state via a TaskApplied event (reducer folds it). */
    function moveTo(taskId: string, state: "completed" | "dropped" | "in_progress") {
      store.record({ type: "TaskApplied", taskId, state });
    }

    test("an open duplicate blocks creation and is reported (id / state / updated_at)", () => {
      const first = taskCreate(store, { title: "経費精算" });
      expect(first.status).toBe("created");

      const second = taskCreate(store, { title: "経費精算" });
      expect(second.status).toBe("existing");
      expect(second.taskId).toBe(first.taskId);
      expect(second.duplicate).toBeDefined();
      expect(second.duplicate?.taskId).toBe(first.taskId);
      expect(second.duplicate?.state).toBe("proposed");
      expect(typeof second.duplicate?.updatedAt).toBe("string");
      expect(tasks()).toHaveLength(1);
    });

    test("an in_progress instance still counts as an open duplicate", () => {
      const first = taskCreate(store, { title: "recurring" });
      moveTo(first.taskId, "in_progress");
      const second = taskCreate(store, { title: "recurring" });
      expect(second.status).toBe("existing");
      expect(second.duplicate?.state).toBe("in_progress");
      expect(tasks()).toHaveLength(1);
    });

    test("once the prior instance is completed, a fresh disambiguated task is created", () => {
      const first = taskCreate(store, { title: "経費精算" });
      moveTo(first.taskId, "completed");

      const second = taskCreate(store, { title: "経費精算" });
      expect(second.status).toBe("created");
      expect(second.taskId).not.toBe(first.taskId);
      expect(second.taskId).toBe(`${first.taskId}~2`);
      expect(second.duplicate).toBeUndefined();
      // The completed instance coexists with the fresh recurrence.
      expect(tasks()).toHaveLength(2);
    });

    test("a dropped instance also frees the title for a fresh recurrence", () => {
      const first = taskCreate(store, { title: "cancelled then redo" });
      moveTo(first.taskId, "dropped");
      const second = taskCreate(store, { title: "cancelled then redo" });
      expect(second.status).toBe("created");
      expect(second.taskId).toBe(`${first.taskId}~2`);
    });

    test("recurrence indices increase monotonically across terminal cycles", () => {
      const base = taskCreate(store, { title: "monthly" }).taskId;
      moveTo(base, "completed");
      const second = taskCreate(store, { title: "monthly" });
      expect(second.taskId).toBe(`${base}~2`);
      moveTo(second.taskId, "completed");
      const third = taskCreate(store, { title: "monthly" });
      expect(third.taskId).toBe(`${base}~3`);
      // While ~3 is open, another create is blocked (points at the open ~3).
      const blocked = taskCreate(store, { title: "monthly" });
      expect(blocked.status).toBe("existing");
      expect(blocked.duplicate?.taskId).toBe(`${base}~3`);
    });

    test("recurrences survive a projection rebuild (event-sourced, ADR-0002)", () => {
      const base = taskCreate(store, { title: "rebuildable recur" }).taskId;
      store.record({ type: "TaskApplied", taskId: base, state: "completed" });
      const second = taskCreate(store, { title: "rebuildable recur" }).taskId;
      store.rebuild();
      const rows = tasks();
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.id === base)?.state).toBe("completed");
      expect(rows.find((r) => r.id === second)?.state).toBe("proposed");
    });
  });

  describe("scheduling fields (ADR-0028)", () => {
    function schedulingOf(taskId: string) {
      return store.connection.sqlite
        .query("SELECT due_date, priority FROM tasks WHERE id = ?")
        .get(taskId) as { due_date: string | null; priority: string | null } | null;
    }

    test("folds dueDate / priority onto the created task", () => {
      const { taskId } = taskCreate(store, {
        title: "with schedule",
        dueDate: "2026-07-01T00:00:00.000Z",
        priority: "high",
      });
      expect(schedulingOf(taskId)).toEqual({
        due_date: "2026-07-01T00:00:00.000Z",
        priority: "high",
      });
    });

    test("dueDate / priority default to null when omitted", () => {
      const { taskId } = taskCreate(store, { title: "no schedule" });
      expect(schedulingOf(taskId)).toEqual({ due_date: null, priority: null });
    });

    test("dueDate / priority are NOT part of the derived id (same title+provenance → same id)", () => {
      const a = taskCreate(store, { title: "same", dueDate: "2026-07-01T00:00:00.000Z" });
      const b = taskCreate(store, { title: "same", priority: "low" });
      expect(b.taskId).toBe(a.taskId);
      // The second is a no-op (existing), so the original dueDate is preserved.
      expect(b.status).toBe("existing");
      expect(schedulingOf(a.taskId)?.due_date).toBe("2026-07-01T00:00:00.000Z");
    });

    test("rejects an invalid priority value", () => {
      // @ts-expect-error invalid priority is rejected by the Zod enum at runtime
      expect(() => taskCreate(store, { title: "bad", priority: "urgent" })).toThrow();
    });
  });
});
