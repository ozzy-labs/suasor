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

  test("a live duplicate is a no-op: `existing` plus the duplicate's id/state/updatedAt (#435)", () => {
    const first = taskCreate(store, { title: "dup", sourceExternalIds: ["gh:1"] });
    expect(first.status).toBe("created");
    const second = taskCreate(store, { title: "dup", sourceExternalIds: ["gh:1"] });
    expect(second.status).toBe("existing");
    expect(second.taskId).toBe(first.taskId);
    // The output discloses the live duplicate so the host can offer reopen-vs-create.
    expect(second.duplicate).toMatchObject({ taskId: first.taskId, state: "proposed" });
    expect(typeof second.duplicate?.updatedAt).toBe("string");
    expect(tasks()).toHaveLength(1);
  });

  test("a terminal (completed) duplicate does NOT block: a new task is created under a `-N` id (#435)", () => {
    const first = taskCreate(store, { title: "経費精算" });
    store.record({ type: "TaskApplied", taskId: first.taskId, state: "completed" });

    const second = taskCreate(store, { title: "経費精算" });
    expect(second.status).toBe("created");
    expect(second.duplicate).toBeUndefined();
    expect(second.taskId).toBe(`${first.taskId}-2`);

    const rows = tasks();
    expect(rows).toHaveLength(2);
    expect(rows.find((t) => t.id === first.taskId)?.state).toBe("completed");
    expect(rows.find((t) => t.id === second.taskId)?.state).toBe("proposed");
  });

  test("recurrence keeps working: each completed generation mints the next suffix", () => {
    const a = taskCreate(store, { title: "monthly" });
    store.record({ type: "TaskApplied", taskId: a.taskId, state: "dropped" });
    const b = taskCreate(store, { title: "monthly" });
    store.record({ type: "TaskApplied", taskId: b.taskId, state: "completed" });
    const c = taskCreate(store, { title: "monthly" });
    expect(c.status).toBe("created");
    expect([a.taskId, b.taskId, c.taskId]).toEqual([a.taskId, `${a.taskId}-2`, `${a.taskId}-3`]);
    expect(tasks()).toHaveLength(3);
  });

  test("with a mix of terminal and live rows, the LIVE one is reported as the duplicate", () => {
    const done = taskCreate(store, { title: "mixed" });
    store.record({ type: "TaskApplied", taskId: done.taskId, state: "completed" });
    const live = taskCreate(store, { title: "mixed" });
    store.record({ type: "TaskApplied", taskId: live.taskId, state: "in_progress" });

    const third = taskCreate(store, { title: "mixed" });
    expect(third.status).toBe("existing");
    expect(third.taskId).toBe(live.taskId);
    expect(third.duplicate?.state).toBe("in_progress");
    expect(tasks()).toHaveLength(2);
  });

  test("rejects an empty title", () => {
    expect(() => taskCreate(store, { title: "" })).toThrow();
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
