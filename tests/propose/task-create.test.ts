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
  return store.connection.sqlite
    .query("SELECT id, title, state FROM tasks")
    .all() as Array<{ id: string; title: string; state: string }>;
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
});
