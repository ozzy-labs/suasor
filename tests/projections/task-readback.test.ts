import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../../src/db/index.ts";
import {
  mapJiraPriority,
  normalizeJiraDue,
  reconcileReadback,
  slackStateFromCells,
  taskStateFromSource,
} from "../../src/projections/task-readback.ts";
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

  test("a not_planned-closed github issue reflects to dropped (not completed)", () => {
    const { taskId } = taskCreate(store, { title: "abandon" });
    publish(taskId, "gh:acme/widgets:issue:7");
    store.record({
      type: "SourceObserved",
      externalId: "gh:acme/widgets:issue:7",
      sourceType: "github_issue",
      body: "issue",
      observedAt: "2026-06-23T00:00:00+00:00",
      fingerprint: "fp-np",
      meta: { state: "closed", state_reason: "not_planned" },
    });
    expect(reconcileReadback(store)).toBe(1);
    expect(stateOf(taskId)).toBe("dropped");
  });

  test("reflects jira due date (normalized) + priority alongside state", () => {
    const { taskId } = taskCreate(store, { title: "jira task" });
    store.record({
      type: "TaskPublished",
      taskId,
      destination: "jira",
      externalId: "jira:acme.atlassian.net:ENG:ENG-9",
      publishedAt: "2026-06-23T00:00:00+00:00",
    });
    store.record({
      type: "SourceObserved",
      externalId: "jira:acme.atlassian.net:ENG:ENG-9",
      sourceType: "jira_issue",
      body: "t",
      observedAt: "2026-06-23T00:00:00+00:00",
      fingerprint: "fp-due-1",
      meta: { statusCategory: "indeterminate", dueDate: "2026-07-01", priority: "High" },
    });
    expect(reconcileReadback(store)).toBe(1);
    const row = store.connection.sqlite
      .query("SELECT state, due_date AS due, priority FROM tasks WHERE id = ?")
      .get(taskId) as { state: string; due: string | null; priority: string | null };
    expect(row).toEqual({
      state: "in_progress",
      due: "2026-07-01T00:00:00+00:00",
      priority: "high",
    });
  });

  test("diff guard: a due-date-only change re-reflects, then no-ops", () => {
    const { taskId } = taskCreate(store, { title: "t" });
    store.record({
      type: "TaskPublished",
      taskId,
      destination: "jira",
      externalId: "jira:h:ENG:ENG-1",
      publishedAt: "2026-06-23T00:00:00+00:00",
    });
    const observe = (due: string, fp: string) =>
      store.record({
        type: "SourceObserved",
        externalId: "jira:h:ENG:ENG-1",
        sourceType: "jira_issue",
        body: "t",
        observedAt: "2026-06-23T00:00:00+00:00",
        fingerprint: fp,
        meta: { statusCategory: "new", dueDate: due, priority: "" },
      });
    observe("2026-07-01", "fp1");
    expect(reconcileReadback(store)).toBe(1); // state open + due set
    observe("2026-07-05", "fp2"); // due moved upstream
    expect(reconcileReadback(store)).toBe(1);
    expect(reconcileReadback(store)).toBe(0); // unchanged → no spam
  });

  test("a checked slack list item reflects its published task to completed (config-driven)", () => {
    const slackHome = { slackCheckboxColumnId: "ColDone" };
    const { taskId } = taskCreate(store, { title: "slack task" });
    store.record({
      type: "TaskPublished",
      taskId,
      destination: "slack",
      externalId: "slack:list:L1:item:Rec5",
      publishedAt: "2026-06-23T00:00:00+00:00",
    });
    store.record({
      type: "SourceObserved",
      externalId: "slack:list:L1:item:Rec5",
      sourceType: "slack_list_item",
      body: "t",
      observedAt: "2026-06-23T00:00:00+00:00",
      fingerprint: "fp-slack-1",
      meta: { listId: "L1", cells: [{ column_id: "ColDone", checkbox: true }] },
    });
    // Without slack home config, the raw cell can't be interpreted → no-op.
    expect(reconcileReadback(store, new Date())).toBe(0);
    // With the [tasks.home] column config, it reflects.
    expect(reconcileReadback(store, new Date(), slackHome)).toBe(1);
    expect(stateOf(taskId)).toBe("completed");
  });

  test("a locally dropped task is sticky: read-back never un-drops it", () => {
    const { taskId } = taskCreate(store, { title: "abandon" });
    publish(taskId, "gh:acme/widgets:issue:7");
    store.record({ type: "TaskApplied", taskId, state: "dropped" }); // local drop (egress no-op'd)
    // The tool still shows the issue open / closed-completed (it can't say "dropped").
    observeIssue("gh:acme/widgets:issue:7", "open");
    expect(reconcileReadback(store)).toBe(0);
    expect(stateOf(taskId)).toBe("dropped"); // not reverted
    observeIssue("gh:acme/widgets:issue:7", "closed");
    expect(reconcileReadback(store)).toBe(0);
    expect(stateOf(taskId)).toBe("dropped");
  });

  test("a genuine external not_planned drop still reflects onto a non-dropped task", () => {
    const { taskId } = taskCreate(store, { title: "t" });
    publish(taskId, "gh:acme/widgets:issue:7");
    store.record({
      type: "SourceObserved",
      externalId: "gh:acme/widgets:issue:7",
      sourceType: "github_issue",
      body: "i",
      observedAt: "2026-06-23T00:00:00+00:00",
      fingerprint: "fp-np2",
      meta: { state: "closed", state_reason: "not_planned" },
    });
    expect(reconcileReadback(store)).toBe(1);
    expect(stateOf(taskId)).toBe("dropped");
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

describe("normalizeJiraDue / mapJiraPriority", () => {
  test("normalizes a bare jira due date to ISO with offset; rejects bad input", () => {
    expect(normalizeJiraDue("2026-07-01")).toBe("2026-07-01T00:00:00+00:00");
    expect(normalizeJiraDue("")).toBeNull();
    expect(normalizeJiraDue("2026/07/01")).toBeNull();
    expect(normalizeJiraDue(null)).toBeNull();
  });

  test("maps jira priority names (case-insensitive) to suasor priority; custom → null", () => {
    expect(mapJiraPriority("Highest")).toBe("high");
    expect(mapJiraPriority("high")).toBe("high");
    expect(mapJiraPriority("Medium")).toBe("normal");
    expect(mapJiraPriority("Lowest")).toBe("low");
    expect(mapJiraPriority("Blocker")).toBeNull();
    expect(mapJiraPriority("")).toBeNull();
  });
});

describe("slackStateFromCells", () => {
  test("checkbox column wins: true→completed, false→open", () => {
    const home = { slackCheckboxColumnId: "C" };
    expect(slackStateFromCells([{ column_id: "C", checkbox: true }], home)).toBe("completed");
    expect(slackStateFromCells([{ column_id: "C", checkbox: false }], home)).toBe("open");
  });

  test("status select maps via option ids (done/dropped/todo)", () => {
    const home = {
      slackStatusColumnId: "S",
      slackDoneOptionId: "od",
      slackTodoOptionId: "ot",
      slackDroppedOptionId: "ox",
    };
    expect(slackStateFromCells([{ column_id: "S", select: ["od"] }], home)).toBe("completed");
    expect(slackStateFromCells([{ column_id: "S", select: ["ox"] }], home)).toBe("dropped");
    expect(slackStateFromCells([{ column_id: "S", select: ["ot"] }], home)).toBe("open");
    expect(slackStateFromCells([{ column_id: "S", select: ["other"] }], home)).toBeNull();
  });

  test("unconfigured / no matching cell → null", () => {
    expect(slackStateFromCells([{ column_id: "X", checkbox: true }], {})).toBeNull();
    expect(slackStateFromCells([], { slackCheckboxColumnId: "C" })).toBeNull();
  });

  test("matches a cell by `key` when the response omits column_id (items.list shape)", () => {
    // slackLists.items.list returns cells keyed by `key`; `column_id` is optional.
    expect(
      slackStateFromCells([{ key: "C", checkbox: true }], { slackCheckboxColumnId: "C" }),
    ).toBe("completed");
    expect(
      slackStateFromCells([{ key: "S", select: ["od"] }], {
        slackStatusColumnId: "S",
        slackDoneOptionId: "od",
      }),
    ).toBe("completed");
  });
});
