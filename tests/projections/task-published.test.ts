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
    // No orphan published_to link for a task that does not exist.
    const links = store.connection.sqlite
      .query("SELECT COUNT(*) AS n FROM links WHERE relation='published_to'")
      .get() as { n: number };
    expect(links.n).toBe(0);
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

describe("[tasks] config — per-destination homes (ADR-0036 R1)", () => {
  test("defaults: no homes, no default, slack exclusion on", () => {
    const c = TasksConfig.parse({});
    expect(c.homes).toEqual({});
    expect(c.default).toBeNull();
    expect(c.slackListExcludeFromIngest).toBe(true);
  });

  test("R1-2: parses [tasks].default", () => {
    const c = TasksConfig.parse({ homes: { github: { repo: "acme/widgets" } }, default: "github" });
    expect(c.default).toBe("github");
  });

  test("rejects an unknown default destination", () => {
    expect(() => TasksConfig.parse({ default: "trello" })).toThrow();
  });

  test("R1-1: parses [tasks.homes.github] (incl. optional Projects v2 board)", () => {
    const c = TasksConfig.parse({
      homes: {
        github: {
          repo: "acme/widgets",
          project: "PVT_kw1",
          statusFieldId: "PVTSSF_s",
          doneOptionId: "od",
          todoOptionId: "ot",
        },
      },
    });
    expect(c.homes.github?.repo).toBe("acme/widgets");
    expect(c.homes.github?.project).toBe("PVT_kw1");
    expect(c.homes.github?.statusFieldId).toBe("PVTSSF_s");
  });

  test("R1-1: a github home requires repo", () => {
    expect(() => TasksConfig.parse({ homes: { github: {} } })).toThrow();
  });

  test("R1-1: parses [tasks.homes.jira] (host + project + transition ids)", () => {
    const c = TasksConfig.parse({
      homes: {
        jira: {
          host: "acme.atlassian.net",
          project: "ENG",
          email: "me@acme.com",
          doneTransitionId: "31",
          reopenTransitionId: "11",
        },
      },
    });
    expect(c.homes.jira?.host).toBe("acme.atlassian.net");
    expect(c.homes.jira?.project).toBe("ENG");
    expect(c.homes.jira?.doneTransitionId).toBe("31");
  });

  test("R1-1: a jira home requires host + project", () => {
    expect(() => TasksConfig.parse({ homes: { jira: { host: "h" } } })).toThrow();
  });

  test("R1-1: parses [tasks.homes.slack] (list + column/option ids)", () => {
    const c = TasksConfig.parse({
      homes: {
        slack: { list: "L1", slackTitleColumnId: "ColTitle", slackCheckboxColumnId: "ColDone" },
      },
    });
    expect(c.homes.slack?.list).toBe("L1");
    expect(c.homes.slack?.slackTitleColumnId).toBe("ColTitle");
  });

  test("R1-1: multiple homes coexist (switched-default scenario)", () => {
    const c = TasksConfig.parse({
      homes: {
        github: { repo: "acme/widgets" },
        jira: { host: "acme.atlassian.net", project: "ENG" },
      },
      default: "github",
    });
    expect(c.homes.github?.repo).toBe("acme/widgets");
    expect(c.homes.jira?.host).toBe("acme.atlassian.net");
    expect(c.default).toBe("github");
  });
});
