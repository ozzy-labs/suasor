import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../../src/db/index.ts";
import { reconcileReadback, taskStateFromSource } from "../../src/projections/task-readback.ts";
import { taskCreate } from "../../src/propose/task-create.ts";

let store: Store;
beforeEach(() => {
  store = Store.open({ path: ":memory:" });
});
afterEach(() => {
  store.close();
});

function publish(taskId: string, externalId: string) {
  store.record({
    type: "TaskPublished",
    taskId,
    destination: "github",
    externalId,
    publishedAt: "2026-06-23T00:00:00+00:00",
  });
}

/** Seed an ingested github_issue source with the given state. */
function observeIssue(externalId: string, state: "open" | "closed") {
  store.record({
    type: "SourceObserved",
    externalId,
    sourceType: "github_issue",
    body: "issue body",
    observedAt: "2026-06-23T00:00:00+00:00",
    fingerprint: `fp-${externalId}-${state}`,
    meta: { state },
  });
}

function stateOf(taskId: string): string | undefined {
  return (
    store.connection.sqlite.query("SELECT state FROM tasks WHERE id = ?").get(taskId) as
      | { state: string }
      | undefined
  )?.state;
}

describe("reconcileReadback (ADR-0036 §6 read-back)", () => {
  test("a closed github_issue reflects its published task to completed", () => {
    const { taskId } = taskCreate(store, { title: "ship" });
    publish(taskId, "gh:acme/widgets:issue:7");
    observeIssue("gh:acme/widgets:issue:7", "closed");

    expect(reconcileReadback(store)).toBe(1);
    expect(stateOf(taskId)).toBe("completed");
  });

  test("diff guard: a second reconcile with no change appends nothing", () => {
    const { taskId } = taskCreate(store, { title: "ship" });
    publish(taskId, "gh:acme/widgets:issue:7");
    observeIssue("gh:acme/widgets:issue:7", "closed");
    reconcileReadback(store);

    const before = store.connection.sqlite.query("SELECT count(*) AS n FROM events").get() as {
      n: number;
    };
    expect(reconcileReadback(store)).toBe(0);
    const after = store.connection.sqlite.query("SELECT count(*) AS n FROM events").get() as {
      n: number;
    };
    expect(after.n).toBe(before.n);
  });

  test("a reopened issue reflects completed → open", () => {
    const { taskId } = taskCreate(store, { title: "reopen" });
    publish(taskId, "gh:acme/widgets:issue:7");
    observeIssue("gh:acme/widgets:issue:7", "closed");
    reconcileReadback(store);
    expect(stateOf(taskId)).toBe("completed");

    observeIssue("gh:acme/widgets:issue:7", "open"); // issue reopened upstream
    expect(reconcileReadback(store)).toBe(1);
    expect(stateOf(taskId)).toBe("open");
  });

  test("a Done jira issue reflects its published task to completed", () => {
    const { taskId } = taskCreate(store, { title: "jira task" });
    store.record({
      type: "TaskPublished",
      taskId,
      destination: "jira",
      externalId: "jira:acme.atlassian.net:ENG:ENG-3",
      publishedAt: "2026-06-23T00:00:00+00:00",
    });
    store.record({
      type: "SourceObserved",
      externalId: "jira:acme.atlassian.net:ENG:ENG-3",
      sourceType: "jira_issue",
      body: "the ticket",
      observedAt: "2026-06-23T00:00:00+00:00",
      fingerprint: "fp-jira-1",
      meta: { statusCategory: "done" },
    });
    expect(reconcileReadback(store)).toBe(1);
    expect(stateOf(taskId)).toBe("completed");
  });

  test("an unpublished task is never reflected", () => {
    taskCreate(store, { title: "local" });
    observeIssue("gh:acme/widgets:issue:7", "closed"); // a source, but no published task links it
    expect(reconcileReadback(store)).toBe(0);
  });

  test("read-back appends no egress event (read → local TaskApplied only)", () => {
    const { taskId } = taskCreate(store, { title: "ship" });
    publish(taskId, "gh:acme/widgets:issue:7");
    observeIssue("gh:acme/widgets:issue:7", "closed");
    reconcileReadback(store);
    const actions = store.connection.sqlite
      .query("SELECT count(*) AS n FROM events WHERE type = 'TaskActionIssued'")
      .get() as { n: number };
    expect(actions.n).toBe(0); // never operates the tool
  });
});

describe("taskStateFromSource", () => {
  test("maps github_issue open/closed; unknown → null", () => {
    expect(taskStateFromSource("github_issue", { state: "closed" })).toBe("completed");
    expect(taskStateFromSource("github_issue", { state: "open" })).toBe("open");
    expect(taskStateFromSource("github_issue", {})).toBeNull();
  });

  test("maps jira_issue by status category; raw status name / unknown → null", () => {
    expect(taskStateFromSource("jira_issue", { statusCategory: "done" })).toBe("completed");
    expect(taskStateFromSource("jira_issue", { statusCategory: "indeterminate" })).toBe(
      "in_progress",
    );
    expect(taskStateFromSource("jira_issue", { statusCategory: "new" })).toBe("open");
    // A raw status name (not a category) or empty → conservative null.
    expect(taskStateFromSource("jira_issue", { status: "Done" })).toBeNull();
    expect(taskStateFromSource("jira_issue", {})).toBeNull();
  });
});
