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
  listSourceHistory,
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

describe("listTasks scheduling / overdue (ADR-0028)", () => {
  // A fixed reference 'now' makes the overdue boundary deterministic (ADR-0028).
  const NOW = "2026-06-20T00:00:00.000Z";

  beforeEach(() => {
    // open + past due → overdue
    store.record({
      type: "TaskProposed",
      taskId: "past",
      title: "past due",
      dueDate: "2026-06-10T00:00:00.000Z",
      sourceExternalIds: [],
    });
    store.record({ type: "TaskApplied", taskId: "past", state: "open" });
    // open + future due → not overdue
    store.record({
      type: "TaskProposed",
      taskId: "future",
      title: "future due",
      dueDate: "2026-06-30T00:00:00.000Z",
      priority: "high",
      sourceExternalIds: [],
    });
    store.record({ type: "TaskApplied", taskId: "future", state: "open" });
    // completed + past due → NOT overdue (not actionable)
    store.record({
      type: "TaskProposed",
      taskId: "done",
      title: "done past due",
      dueDate: "2026-06-01T00:00:00.000Z",
      sourceExternalIds: [],
    });
    store.record({ type: "TaskApplied", taskId: "done", state: "completed" });
    // open + no due date → never overdue
    store.record({ type: "TaskProposed", taskId: "nodue", title: "no due", sourceExternalIds: [] });
    store.record({ type: "TaskApplied", taskId: "nodue", state: "open" });
  });

  test("derives overdue at read time: past due AND open/in_progress only", () => {
    const all = listTasks(sqlite(), { now: NOW });
    const byId = new Map(all.map((t) => [t.id, t.overdue]));
    expect(byId.get("past")).toBe(true);
    expect(byId.get("future")).toBe(false);
    expect(byId.get("done")).toBe(false); // completed → not actionable
    expect(byId.get("nodue")).toBe(false); // no due date
  });

  test("overdue filter keeps only overdue tasks", () => {
    const overdue = listTasks(sqlite(), { overdue: true, now: NOW });
    expect(overdue.map((t) => t.id)).toEqual(["past"]);
  });

  test("a legacy task (dueDate=null) is never overdue", () => {
    const nodue = listTasks(sqlite(), { now: NOW }).find((t) => t.id === "nodue");
    expect(nodue?.dueDate).toBeNull();
    expect(nodue?.overdue).toBe(false);
  });

  test("dueBefore filters by due_date and excludes null due dates", () => {
    const before = listTasks(sqlite(), { dueBefore: "2026-06-15T00:00:00.000Z", now: NOW });
    // past (06-10) and done (06-01) are < 06-15; future / nodue excluded.
    expect(before.map((t) => t.id).sort()).toEqual(["done", "past"]);
  });

  test("exposes dueDate / priority on the record", () => {
    const future = listTasks(sqlite(), { now: NOW }).find((t) => t.id === "future");
    expect(future?.dueDate).toBe("2026-06-30T00:00:00.000Z");
    expect(future?.priority).toBe("high");
  });

  test("overdue boundary is exclusive: a task due exactly at now is not overdue", () => {
    store.record({
      type: "TaskProposed",
      taskId: "exact",
      title: "due exactly now",
      dueDate: NOW,
      sourceExternalIds: [],
    });
    store.record({ type: "TaskApplied", taskId: "exact", state: "open" });
    const exact = listTasks(sqlite(), { now: NOW }).find((t) => t.id === "exact");
    expect(exact?.overdue).toBe(false);
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

  test("expandGraph direction filters the traversal (ADR-0020 graph.trace)", () => {
    // Graph: task:t1 --derived_from--> source:s1 <--derived_from-- decision:d1
    store.record({ type: "TaskProposed", taskId: "t1", title: "t", sourceExternalIds: ["s1"] });
    store.record({
      type: "DecisionRecorded",
      decisionId: "d1",
      title: "d",
      rationale: "",
      sourceExternalIds: ["s1"],
    });

    // both (default) reaches every node — backwards compatible.
    const both = expandGraph(sqlite(), "task", "t1", { depth: 2, direction: "both" });
    expect(both.nodes.map((n) => `${n.kind}:${n.id}`).sort()).toEqual([
      "decision:d1",
      "source:s1",
      "task:t1",
    ]);
    expect(both).toEqual(expandGraph(sqlite(), "task", "t1", { depth: 2 }));

    // out from t1 follows the outgoing derived_from to s1, but s1 has no
    // outgoing edge, so d1 (an incoming neighbour of s1) is not reached.
    const out = expandGraph(sqlite(), "task", "t1", { depth: 2, direction: "out" });
    expect(out.nodes.map((n) => `${n.kind}:${n.id}`).sort()).toEqual(["source:s1", "task:t1"]);
    expect(out.edges).toHaveLength(1);

    // in from t1: t1 has no incoming edge, so the traversal stops at the origin.
    const inFromTask = expandGraph(sqlite(), "task", "t1", { depth: 2, direction: "in" });
    expect(inFromTask.nodes.map((n) => `${n.kind}:${n.id}`)).toEqual(["task:t1"]);
    expect(inFromTask.edges).toHaveLength(0);

    // in from s1: backward provenance trace finds both consumers (t1, d1).
    const inFromSource = expandGraph(sqlite(), "source", "s1", { depth: 2, direction: "in" });
    expect(inFromSource.nodes.map((n) => `${n.kind}:${n.id}`).sort()).toEqual([
      "decision:d1",
      "source:s1",
      "task:t1",
    ]);
    expect(inFromSource.edges).toHaveLength(2);
  });

  test("expandGraph direction preserves cycle guard + edge dedup", () => {
    // Diamond: t1 -> s1, d1 -> s1; from s1 the `in` traversal reaches t1 and d1
    // each exactly once (visited-set) with each edge emitted once (seenEdges).
    store.record({ type: "TaskProposed", taskId: "t1", title: "t", sourceExternalIds: ["s1"] });
    store.record({
      type: "DecisionRecorded",
      decisionId: "d1",
      title: "d",
      rationale: "",
      sourceExternalIds: ["s1"],
    });
    const g = expandGraph(sqlite(), "source", "s1", { depth: 5, direction: "in" });
    expect(g.nodes).toHaveLength(3); // s1, t1, d1 — no revisits
    expect(g.edges).toHaveLength(2); // t1->s1, d1->s1 — no duplicates
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

describe("listSourceHistory", () => {
  test("returns every body version newest-first from the event log", () => {
    store.record({
      type: "SourceObserved",
      externalId: "gh:1",
      sourceType: "github_issue",
      body: "v1 body",
      observedAt: "2026-06-01T00:00:00.000Z",
      fingerprint: "fp1",
      meta: {},
    });
    store.record({
      type: "SourceBodyUpdated",
      externalId: "gh:1",
      body: "v2 body",
      observedAt: "2026-06-02T00:00:00.000Z",
      fingerprint: "fp2",
      meta: {},
    });

    const history = listSourceHistory(sqlite(), "gh:1");
    expect(history).toHaveLength(2);
    // Newest first: the projection keeps only v2, but the log retains both.
    expect(history[0]?.body).toBe("v2 body");
    expect(history[0]?.fingerprint).toBe("fp2");
    expect(history[1]?.body).toBe("v1 body");
    // The current projection body matches the latest version.
    expect(getSource(sqlite(), "gh:1")?.body).toBe("v2 body");
  });

  test("returns an empty array for an unknown source", () => {
    expect(listSourceHistory(sqlite(), "nope:1")).toEqual([]);
  });

  test("honours the limit (newest versions first)", () => {
    store.record({
      type: "SourceObserved",
      externalId: "gh:2",
      sourceType: "github_issue",
      body: "first",
      observedAt: "2026-06-01T00:00:00.000Z",
      fingerprint: "a",
      meta: {},
    });
    store.record({
      type: "SourceBodyUpdated",
      externalId: "gh:2",
      body: "second",
      observedAt: "2026-06-02T00:00:00.000Z",
      fingerprint: "b",
      meta: {},
    });
    const limited = listSourceHistory(sqlite(), "gh:2", { limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0]?.body).toBe("second");
  });
});
