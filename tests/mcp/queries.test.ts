import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../../src/db/index.ts";
import {
  buildBrief,
  expandGraph,
  getSource,
  listDecisions,
  listInbox,
  listLinks,
  listSlackDemand,
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

describe("listSlackDemand (ADR-0012)", () => {
  /** Seed a slack_message source with a channel + body. */
  function slack(externalId: string, channel: string, body: string, observedAt: string) {
    store.record({
      type: "SourceObserved",
      externalId,
      sourceType: "slack_message",
      body,
      observedAt,
      fingerprint: externalId,
      meta: { team: "T1", channel, ts: externalId },
    });
  }

  test("detects @mentions of self and DMs; ignores ordinary messages", () => {
    slack("m1", "C1", "hey <@U_ME> can you review", "2026-06-10T00:00:00.000Z"); // mention
    slack("d1", "D9", "direct hello", "2026-06-11T00:00:00.000Z"); // DM
    slack("n1", "C1", "unrelated channel chatter", "2026-06-12T00:00:00.000Z"); // neither
    const rows = listSlackDemand(sqlite(), { selfUserIds: ["U_ME"] });
    expect(rows.map((r) => r.externalId).sort()).toEqual(["d1", "m1"]);
    expect(rows.find((r) => r.externalId === "d1")?.kind).toBe("dm");
    expect(rows.find((r) => r.externalId === "m1")?.kind).toBe("mention");
  });

  test("newest-first by observed_at", () => {
    slack("d1", "D9", "older", "2026-06-10T00:00:00.000Z");
    slack("d2", "D9", "newer", "2026-06-12T00:00:00.000Z");
    expect(listSlackDemand(sqlite()).map((r) => r.externalId)).toEqual(["d2", "d1"]);
  });

  test("kinds=['dm'] excludes mentions; ['mention'] excludes DMs", () => {
    slack("m1", "C1", "ping <@U_ME>", "2026-06-10T00:00:00.000Z");
    slack("d1", "D9", "dm", "2026-06-11T00:00:00.000Z");
    expect(
      listSlackDemand(sqlite(), { selfUserIds: ["U_ME"], kinds: ["dm"] }).map((r) => r.externalId),
    ).toEqual(["d1"]);
    expect(
      listSlackDemand(sqlite(), { selfUserIds: ["U_ME"], kinds: ["mention"] }).map(
        (r) => r.externalId,
      ),
    ).toEqual(["m1"]);
  });

  test("without selfUserIds, default kinds returns DMs only", () => {
    slack("m1", "C1", "ping <@U_ME>", "2026-06-10T00:00:00.000Z");
    slack("d1", "D9", "dm", "2026-06-11T00:00:00.000Z");
    expect(listSlackDemand(sqlite()).map((r) => r.externalId)).toEqual(["d1"]);
  });

  test("mention-only with no selfUserIds yields nothing (no predicate)", () => {
    slack("d1", "D9", "dm", "2026-06-11T00:00:00.000Z");
    expect(listSlackDemand(sqlite(), { kinds: ["mention"] })).toEqual([]);
  });

  test("matches any of several self user ids", () => {
    slack("m1", "C1", "hi <@U_ALT>", "2026-06-10T00:00:00.000Z");
    expect(
      listSlackDemand(sqlite(), { selfUserIds: ["U_ME", "U_ALT"], kinds: ["mention"] }).map(
        (r) => r.externalId,
      ),
    ).toEqual(["m1"]);
  });

  test("respects the observed window and limit", () => {
    slack("d1", "D9", "a", "2026-06-10T00:00:00.000Z");
    slack("d2", "D9", "b", "2026-06-11T00:00:00.000Z");
    slack("d3", "D9", "c", "2026-06-12T00:00:00.000Z");
    const windowed = listSlackDemand(sqlite(), { observed: { after: "2026-06-11T00:00:00.000Z" } });
    expect(windowed.map((r) => r.externalId)).toEqual(["d3", "d2"]);
    expect(listSlackDemand(sqlite(), { limit: 1 }).map((r) => r.externalId)).toEqual(["d3"]);
  });
});

describe("buildBrief (ADR-0017)", () => {
  const W0 = "2026-06-10T00:00:00.000Z"; // before window
  const W1 = "2026-06-12T00:00:00.000Z"; // window start
  const W2 = "2026-06-14T00:00:00.000Z"; // window end (exclusive)

  function seed() {
    // sources: one in-window (observed), one before
    source("s-in", "2026-06-13T00:00:00.000Z");
    source("s-old", W0);
    // a slack DM in-window
    store.record({
      type: "SourceObserved",
      externalId: "d-in",
      sourceType: "slack_message",
      body: "dm",
      observedAt: "2026-06-13T01:00:00.000Z",
      fingerprint: "d-in",
      meta: { team: "T1", channel: "D9" },
    });
    // decision recorded in-window (recorded_at = the provided clock)
    const inWindow = new Date("2026-06-13T00:00:00.000Z");
    store.record(
      { type: "DecisionRecorded", decisionId: "dec1", title: "d", rationale: "" },
      inWindow,
    );
    // open inbox item (current, not time-scoped)
    store.record({
      type: "InboxItemTriaged",
      inboxId: "i1",
      sourceExternalId: "s-in",
      state: "open",
    });
  }

  test("bundles each section by its natural time column", () => {
    seed();
    const b = buildBrief(sqlite(), { since: W1, until: W2 });
    expect(b.window).toEqual({ since: W1, until: W2 });
    expect(b.sources.map((s) => s.externalId).sort()).toEqual(["d-in", "s-in"]); // s-old excluded
    expect(b.decisions.map((d) => d.id)).toEqual(["dec1"]);
    expect(b.inbox.map((i) => i.id)).toEqual(["i1"]);
    expect(b.demand.map((d) => d.externalId)).toEqual(["d-in"]); // DM detected
  });

  test("an out-of-window query yields empty sections", () => {
    seed();
    const b = buildBrief(sqlite(), { since: "2026-07-01T00:00:00.000Z" });
    expect(b.sources).toEqual([]);
    expect(b.decisions).toEqual([]);
    expect(b.demand).toEqual([]);
  });

  test("limit caps each section", () => {
    source("a", "2026-06-13T00:00:00.000Z");
    source("b", "2026-06-13T01:00:00.000Z");
    source("c", "2026-06-13T02:00:00.000Z");
    const b = buildBrief(sqlite(), { since: W1, until: W2, limit: 2 });
    expect(b.sources).toHaveLength(2);
  });
});

describe("graph traversal: listLinks / expandGraph (ADR-0018)", () => {
  test("listLinks returns provenance neighbours in both directions", () => {
    // The reducer materialises task --derived_from--> source from sourceExternalIds.
    store.record({ type: "TaskProposed", taskId: "t1", title: "t", sourceExternalIds: ["s1"] });
    expect(listLinks(sqlite(), "source", "s1")).toEqual([
      { kind: "task", id: "t1", relation: "derived_from", direction: "in" },
    ]);
    expect(listLinks(sqlite(), "task", "t1")).toEqual([
      { kind: "source", id: "s1", relation: "derived_from", direction: "out" },
    ]);
  });

  test("direction and relation filters", () => {
    store.record({ type: "TaskProposed", taskId: "t1", title: "t", sourceExternalIds: ["s1"] });
    expect(listLinks(sqlite(), "task", "t1", { direction: "in" })).toEqual([]); // no incoming
    expect(listLinks(sqlite(), "task", "t1", { relation: "replies_to" })).toEqual([]); // wrong relation
  });

  test("expandGraph traverses multi-hop with cycle guard + edge dedup", () => {
    store.record({ type: "TaskProposed", taskId: "t1", title: "t", sourceExternalIds: ["s1"] });
    store.record({
      type: "DecisionRecorded",
      decisionId: "d1",
      title: "d",
      rationale: "",
      sourceExternalIds: ["s1"],
    });
    const g = expandGraph(sqlite(), "task", "t1", { depth: 2 });
    expect(g.nodes.map((n) => `${n.kind}:${n.id}`).sort()).toEqual([
      "decision:d1",
      "source:s1",
      "task:t1",
    ]);
    expect(g.edges).toHaveLength(2); // t1->s1, d1->s1 (no duplicate t1->s1)
  });

  test("expandGraph respects the node limit", () => {
    store.record({
      type: "TaskProposed",
      taskId: "t1",
      title: "t",
      sourceExternalIds: ["s1", "s2", "s3"],
    });
    expect(expandGraph(sqlite(), "task", "t1", { depth: 2, limit: 2 }).nodes).toHaveLength(2);
  });
});
