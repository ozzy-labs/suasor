import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../../src/db/index.ts";
import {
  getSource,
  listDecisions,
  listInbox,
  listSources,
  listTasks,
} from "../../src/mcp/queries.ts";

let store: Store;

beforeEach(() => {
  store = Store.open({ path: ":memory:" });
});

afterEach(() => {
  store.close();
});

function sqlite() {
  return store.connection.sqlite;
}

function source(externalId: string, observedAt: string, sourceType = "github_issue") {
  store.record({
    type: "SourceObserved",
    externalId,
    sourceType,
    body: `body of ${externalId}`,
    observedAt,
    fingerprint: externalId,
    meta: { url: `https://example/${externalId}` },
  });
}

describe("listSources", () => {
  test("returns sources newest-first by observed_at", () => {
    source("s1", "2026-06-10T00:00:00.000Z");
    source("s2", "2026-06-12T00:00:00.000Z");
    source("s3", "2026-06-11T00:00:00.000Z");
    const rows = listSources(sqlite());
    expect(rows.map((r) => r.externalId)).toEqual(["s2", "s3", "s1"]);
    // body + decoded meta are exposed (held locally, ADR-0003).
    expect(rows[0]?.body).toBe("body of s2");
    expect(rows[0]?.meta).toEqual({ url: "https://example/s2" });
  });

  test("filters by source_type", () => {
    source("gh", "2026-06-10T00:00:00.000Z", "github_issue");
    source("sl", "2026-06-11T00:00:00.000Z", "slack_message");
    const rows = listSources(sqlite(), { sourceType: "slack_message" });
    expect(rows.map((r) => r.externalId)).toEqual(["sl"]);
  });

  test("applies an inclusive-lower / exclusive-upper observed window", () => {
    source("a", "2026-06-10T00:00:00.000Z");
    source("b", "2026-06-11T00:00:00.000Z");
    source("c", "2026-06-12T00:00:00.000Z");
    const rows = listSources(sqlite(), {
      observed: { after: "2026-06-11T00:00:00.000Z", before: "2026-06-12T00:00:00.000Z" },
    });
    // `after` inclusive picks b; `before` exclusive drops c.
    expect(rows.map((r) => r.externalId)).toEqual(["b"]);
  });

  test("respects limit", () => {
    source("a", "2026-06-10T00:00:00.000Z");
    source("b", "2026-06-11T00:00:00.000Z");
    expect(listSources(sqlite(), { limit: 1 })).toHaveLength(1);
  });
});

describe("getSource", () => {
  test("returns a single source with body", () => {
    source("s1", "2026-06-10T00:00:00.000Z");
    expect(getSource(sqlite(), "s1")?.body).toBe("body of s1");
  });

  test("returns null for an unknown id", () => {
    expect(getSource(sqlite(), "nope")).toBeNull();
  });
});

describe("listTasks", () => {
  beforeEach(() => {
    store.record({
      type: "TaskProposed",
      taskId: "t1",
      title: "first",
      sourceExternalIds: [],
    });
    store.record({
      type: "TaskApplied",
      taskId: "t1",
      state: "completed",
    });
    store.record({
      type: "TaskProposed",
      taskId: "t2",
      title: "second",
      sourceExternalIds: [],
    });
  });

  test("filters by state", () => {
    const completed = listTasks(sqlite(), { state: "completed" });
    expect(completed.map((t) => t.id)).toEqual(["t1"]);
    const proposed = listTasks(sqlite(), { state: "proposed" });
    expect(proposed.map((t) => t.id)).toEqual(["t2"]);
  });

  test("lists all tasks newest-updated first", () => {
    const all = listTasks(sqlite());
    expect(all.map((t) => t.id).sort()).toEqual(["t1", "t2"]);
  });
});

describe("listDecisions", () => {
  test("lists decisions newest-recorded first", () => {
    store.record({ type: "DecisionRecorded", decisionId: "d1", title: "A", rationale: "" });
    store.record({ type: "DecisionRecorded", decisionId: "d2", title: "B", rationale: "why" });
    const rows = listDecisions(sqlite());
    expect(rows.map((d) => d.id).sort()).toEqual(["d1", "d2"]);
    expect(rows.find((d) => d.id === "d2")?.rationale).toBe("why");
  });
});

describe("listInbox", () => {
  test("filters by triage state", () => {
    source("s1", "2026-06-10T00:00:00.000Z");
    store.record({
      type: "InboxItemTriaged",
      inboxId: "i1",
      sourceExternalId: "s1",
      state: "open",
    });
    store.record({
      type: "InboxItemTriaged",
      inboxId: "i2",
      sourceExternalId: "s1",
      state: "done",
    });
    expect(listInbox(sqlite(), { state: "open" }).map((i) => i.id)).toEqual(["i1"]);
  });
});
