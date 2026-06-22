import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TasksConfig } from "../../src/config/schema.ts";
import { Store } from "../../src/db/index.ts";
import { TaskActionIssued, TaskPublished } from "../../src/events/types.ts";
import { taskCreate } from "../../src/propose/task-create.ts";

let store: Store;
beforeEach(() => {
  store = Store.open({ path: ":memory:" });
});
afterEach(() => {
  store.close();
});

function publishedRow(id: string) {
  return store.connection.sqlite
    .query(
      "SELECT published_destination AS dest, published_external_id AS ext, published_at AS at FROM tasks WHERE id = ?",
    )
    .get(id) as { dest: string | null; ext: string | null; at: string | null } | null;
}

describe("TaskPublished / TaskActionIssued event schemas (ADR-0036)", () => {
  test("TaskPublished parses required fields", () => {
    const e = TaskPublished.parse({
      type: "TaskPublished",
      id: "e1",
      recordedAt: "2026-06-22T00:00:00+00:00",
      taskId: "t1",
      destination: "github",
      externalId: "gh:o/r:issue:1",
      publishedAt: "2026-06-22T00:00:00+00:00",
    });
    expect(e.destination).toBe("github");
    expect(e.schemaVersion).toBe(1);
  });

  test("TaskPublished rejects an unknown destination", () => {
    expect(() =>
      TaskPublished.parse({
        type: "TaskPublished",
        id: "e1",
        recordedAt: "2026-06-22T00:00:00+00:00",
        taskId: "t1",
        destination: "trello",
        externalId: "x",
        publishedAt: "2026-06-22T00:00:00+00:00",
      }),
    ).toThrow();
  });

  test("TaskActionIssued parses the action enum", () => {
    const e = TaskActionIssued.parse({
      type: "TaskActionIssued",
      id: "e2",
      recordedAt: "2026-06-22T00:00:00+00:00",
      taskId: "t1",
      externalId: "gh:o/r:issue:1",
      action: "complete",
      issuedAt: "2026-06-22T00:00:00+00:00",
    });
    expect(e.action).toBe("complete");
  });
});

describe("reducer: TaskPublished / TaskActionIssued (ADR-0036)", () => {
  test("TaskPublished folds the external link onto the task + a published_to link", () => {
    const { taskId } = taskCreate(store, { title: "t" });
    store.record({
      type: "TaskPublished",
      taskId,
      destination: "github",
      externalId: "gh:o/r:issue:5",
      publishedAt: "2026-06-22T00:00:00+00:00",
    });
    const r = publishedRow(taskId);
    expect(r).toMatchObject({ dest: "github", ext: "gh:o/r:issue:5" });
    const link = store.connection.sqlite
      .query("SELECT to_id FROM links WHERE from_kind='task' AND relation='published_to'")
      .get() as { to_id: string } | null;
    expect(link?.to_id).toBe("gh:o/r:issue:5");
  });

  test("TaskPublished for an unknown task is a no-op (does not fabricate a row)", () => {
    store.record({
      type: "TaskPublished",
      taskId: "ghost",
      destination: "github",
      externalId: "gh:o/r:issue:9",
      publishedAt: "2026-06-22T00:00:00+00:00",
    });
    expect(publishedRow("ghost")).toBeNull();
  });

  test("TaskActionIssued is a projection no-op (audit only)", () => {
    const { taskId } = taskCreate(store, { title: "t" });
    const before = publishedRow(taskId);
    store.record({
      type: "TaskActionIssued",
      taskId,
      externalId: "gh:o/r:issue:5",
      action: "complete",
      issuedAt: "2026-06-22T00:00:00+00:00",
    });
    expect(publishedRow(taskId)).toEqual(before);
  });

  test("rebuild idempotence: replaying yields the same published link", () => {
    const { taskId } = taskCreate(store, { title: "t" });
    store.record({
      type: "TaskPublished",
      taskId,
      destination: "github",
      externalId: "gh:o/r:issue:5",
      publishedAt: "2026-06-22T00:00:00+00:00",
    });
    const before = publishedRow(taskId);
    store.rebuild();
    expect(publishedRow(taskId)).toEqual(before);
  });
});

describe("[tasks] config (ADR-0036)", () => {
  test("defaults: no home, slack exclusion on", () => {
    const c = TasksConfig.parse({});
    expect(c.home).toBeNull();
    expect(c.slackListExcludeFromIngest).toBe(true);
  });

  test("parses a github home", () => {
    const c = TasksConfig.parse({ home: { destination: "github", repo: "acme/widgets" } });
    expect(c.home?.destination).toBe("github");
    expect(c.home?.repo).toBe("acme/widgets");
  });

  test("rejects an unknown destination", () => {
    expect(() => TasksConfig.parse({ home: { destination: "trello" } })).toThrow();
  });
});
