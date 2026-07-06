/**
 * Derived-content cascade + reject-time summary redaction (ADR-0026 R1-2 / R1-3).
 *
 * Covers the second half of ADR-0026 R1 (Issue #416): the source body flowed into
 * derived free-text at propose/apply time (task/decision titles, decision
 * rationale, reply-draft bodies, commitment titles, proposal-ledger summaries), so
 * a plain `source.forget` leaves those quotes behind. These tests assert that
 * forget ALWAYS discloses the derived entities, that `cascade` redacts their
 * free-text (event log + projection, replay-stable), and that `propose.reject`
 * independently redacts a rejected candidate's summary (the reply-draft leak).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { z } from "zod";
import { Store } from "../../src/db/index.ts";
import { enumerateDerived, REDACTED_TEXT } from "../../src/forget/cascade.ts";
import { sourceForget } from "../../src/forget/source-forget.ts";
import { listProposals } from "../../src/mcp/queries.ts";
import { proposeApply } from "../../src/propose/apply.ts";
import type { Candidate, CandidateInput, ProposeMode } from "../../src/propose/candidates.ts";
import { persistProposals } from "../../src/propose/generate.ts";
import { proposeReject } from "../../src/propose/reject.ts";

/** Pre-parse candidate shape (defaults not yet applied) accepted by generate. */
type CandidateIn = z.input<typeof CandidateInput>;

let store: Store;

beforeEach(() => {
  store = Store.open({ path: ":memory:" });
});

afterEach(() => {
  store.close();
});

const sqlite = () => store.connection.sqlite;

function ingest(externalId: string, body: string): void {
  store.record({
    type: "SourceObserved",
    externalId,
    sourceType: "github_issue",
    body,
    observedAt: "2026-06-14T00:00:00.000Z",
    fingerprint: externalId,
    meta: {},
  });
}

/** Generate a ledger candidate and apply it (persist entity). Returns candidateId. */
function generateApply(mode: ProposeMode, candidate: CandidateIn): string {
  const g = persistProposals(store, { mode, candidates: [candidate] });
  proposeApply(store, { candidates: g.candidates as Candidate[] });
  return g.candidates[0]?.candidateId as string;
}

/** Generate a ledger candidate WITHOUT applying it (stays a pending proposal). */
function generateOnly(mode: ProposeMode, candidate: CandidateIn): string {
  const g = persistProposals(store, { mode, candidates: [candidate] });
  return g.candidates[0]?.candidateId as string;
}

/** Read a single free-text column off a projection row. */
function col(table: string, column: string): string | undefined {
  return (sqlite().query(`SELECT ${column} AS v FROM ${table} LIMIT 1`).get() as { v: string })?.v;
}

/** Every free-text value of a given kind across the event log. */
function eventField(type: string, path: string): string[] {
  return sqlite()
    .query<{ v: string }, [string]>(
      `SELECT json_extract(payload, '${path}') AS v FROM events WHERE type = ?`,
    )
    .all(type)
    .map((r) => r.v);
}

/** Count event rows whose payload still contains a needle (leak assertions). */
function eventsContaining(needle: string): number {
  return (
    sqlite()
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM events WHERE payload LIKE ?")
      .get(`%${needle}%`)?.n ?? 0
  );
}

describe("source.forget derived-content disclosure (ADR-0026 R1-2)", () => {
  test("enumerates derived task/decision/commitment/reply_draft + proposal + draft_export", () => {
    ingest("gh:1", "SECRET body");
    generateApply("source_extract", {
      kind: "task",
      title: "SECRET task",
      sourceExternalIds: ["gh:1"],
    });
    generateApply("source_extract", {
      kind: "decision",
      title: "SECRET decision",
      rationale: "SECRET why",
      sourceExternalIds: ["gh:1"],
    });
    generateApply("commitment_scan", {
      kind: "commitment",
      title: "SECRET commitment",
      direction: "owed_by_me",
      sourceExternalIds: ["gh:1"],
    });
    generateApply("reply_draft", {
      kind: "reply_draft",
      body: "SECRET reply",
      replyToExternalId: "gh:1",
    });
    // A never-applied (still pending) proposal derived from the source.
    generateOnly("source_extract", {
      kind: "task",
      title: "SECRET pending",
      sourceExternalIds: ["gh:1"],
    });
    // An exported draft (out of scope — file lives outside the DB).
    store.record({
      type: "DraftExported",
      path: "/exports/d.md",
      format: "md",
      sourceExternalId: "gh:1",
    });

    const derived = enumerateDerived(sqlite(), "gh:1");
    const kinds = derived.map((d) => d.kind).sort();
    // task/decision/commitment/reply_draft links + 5 proposals (one per generate) +
    // one draft_export.
    expect(kinds.filter((k) => k === "task")).toHaveLength(1);
    expect(kinds.filter((k) => k === "decision")).toHaveLength(1);
    expect(kinds.filter((k) => k === "commitment")).toHaveLength(1);
    expect(kinds.filter((k) => k === "reply_draft")).toHaveLength(1);
    expect(kinds.filter((k) => k === "proposal")).toHaveLength(5);
    // draft_export is disclosed but flagged non-redactable (out of scope).
    const exp = derived.find((d) => d.kind === "draft_export");
    expect(exp).toBeDefined();
    expect(exp?.redactable).toBe(false);
    expect(exp?.id).toBe("/exports/d.md");
  });

  test("a plain forget discloses derived entities but leaves their text intact", () => {
    ingest("gh:1", "SECRET body");
    generateApply("source_extract", {
      kind: "task",
      title: "SECRET task",
      sourceExternalIds: ["gh:1"],
    });

    const out = sourceForget(store, { externalId: "gh:1" });
    expect(out.status).toBe("forgotten");
    expect(out.cascaded).toBe(false);
    // Disclosure present (mandatory) even without cascade.
    expect(out.derived.some((d) => d.kind === "task")).toBe(true);
    // But the derived quote is NOT redacted on a plain forget.
    expect(col("tasks", "title")).toBe("SECRET task");
    expect(eventField("TaskProposed", "$.title")).toEqual(["SECRET task"]);
  });

  test("missing source returns empty derived and does not cascade", () => {
    const out = sourceForget(store, { externalId: "nope:1", cascade: true });
    expect(out.status).toBe("missing");
    expect(out.derived).toEqual([]);
    expect(out.cascaded).toBe(false);
  });
});

describe("source.forget cascade redaction (ADR-0026 R1-2)", () => {
  test("cascade redacts every derived free-text field (event log + projection)", () => {
    ingest("gh:1", "SECRET source");
    generateApply("source_extract", {
      kind: "task",
      title: "SECRET task",
      sourceExternalIds: ["gh:1"],
    });
    generateApply("source_extract", {
      kind: "decision",
      title: "SECRET decision",
      rationale: "SECRET rationale",
      sourceExternalIds: ["gh:1"],
    });
    generateApply("commitment_scan", {
      kind: "commitment",
      title: "SECRET commitment",
      direction: "owed_by_me",
      sourceExternalIds: ["gh:1"],
    });
    generateApply("reply_draft", {
      kind: "reply_draft",
      body: "SECRET reply body",
      replyToExternalId: "gh:1",
    });

    const out = sourceForget(store, { externalId: "gh:1", cascade: true });
    expect(out.status).toBe("forgotten");
    expect(out.cascaded).toBe(true);

    // Projection columns blanked to the marker.
    expect(col("tasks", "title")).toBe(REDACTED_TEXT);
    expect(
      sqlite().query("SELECT title, rationale FROM decisions").get() as {
        title: string;
        rationale: string;
      },
    ).toEqual({ title: REDACTED_TEXT, rationale: REDACTED_TEXT });
    expect(col("commitments", "title")).toBe(REDACTED_TEXT);

    // Event log blanked too (the replay source of truth).
    expect(eventField("TaskProposed", "$.title")).toEqual([REDACTED_TEXT]);
    expect(eventField("DecisionRecorded", "$.rationale")).toEqual([REDACTED_TEXT]);
    expect(eventField("CommitmentOpened", "$.title")).toEqual([REDACTED_TEXT]);
    expect(eventField("ReplyDraftProposed", "$.body")).toEqual([REDACTED_TEXT]);
    // Proposal-ledger summaries (which hold the reply body verbatim) blanked.
    for (const p of listProposals(sqlite(), {})) expect(p.summary).toBe(REDACTED_TEXT);

    // No derived event still quotes the source (the acceptance for R1-2). The
    // SECRET source body events themselves are already blanked by the base forget.
    expect(eventsContaining("SECRET")).toBe(0);
  });

  test("cascade redaction is replay-stable (survives a projections rebuild)", () => {
    ingest("gh:1", "SECRET source");
    generateApply("source_extract", {
      kind: "task",
      title: "SECRET task",
      sourceExternalIds: ["gh:1"],
    });
    generateApply("source_extract", {
      kind: "decision",
      title: "keep title",
      rationale: "SECRET rationale",
      sourceExternalIds: ["gh:1"],
    });

    sourceForget(store, { externalId: "gh:1", cascade: true });
    store.rebuild(); // truncate + replay every event through the reducer

    // The redacted derived text is reproduced from the redacted events — it must
    // not resurrect the original quote (the R1-2 acceptance: "replay 後も維持").
    expect(col("tasks", "title")).toBe(REDACTED_TEXT);
    expect(
      (sqlite().query("SELECT rationale FROM decisions").get() as { rationale: string }).rationale,
    ).toBe(REDACTED_TEXT);
    expect(eventsContaining("SECRET")).toBe(0);
  });

  test("cascade only touches entities derived from the forgotten source", () => {
    ingest("gh:1", "forget me");
    ingest("gh:2", "keep me");
    generateApply("source_extract", {
      kind: "task",
      title: "gh1 task",
      sourceExternalIds: ["gh:1"],
    });
    generateApply("source_extract", {
      kind: "task",
      title: "gh2 task",
      sourceExternalIds: ["gh:2"],
    });

    sourceForget(store, { externalId: "gh:1", cascade: true });

    const titles = sqlite()
      .query<{ title: string }, []>("SELECT title FROM tasks ORDER BY title")
      .all()
      .map((r) => r.title);
    // gh:1's task redacted; gh:2's task untouched.
    expect(titles).toEqual([REDACTED_TEXT, "gh2 task"]);
  });

  test("draft-export paths are disclosed but never redacted (out of scope)", () => {
    ingest("gh:1", "SECRET source");
    store.record({
      type: "DraftExported",
      path: "/exports/secret.md",
      format: "md",
      sourceExternalId: "gh:1",
    });

    const out = sourceForget(store, { externalId: "gh:1", cascade: true });
    const exp = out.derived.find((d) => d.kind === "draft_export");
    expect(exp?.redactable).toBe(false);
    // The DraftExported event is body-less and its path is preserved (the file
    // itself is outside the DB — ADR-0026 Negative).
    expect(eventField("DraftExported", "$.path")).toEqual(["/exports/secret.md"]);
  });

  test("cascade can run on an already-forgotten source (plain forget, then --cascade)", () => {
    ingest("gh:1", "SECRET source");
    generateApply("source_extract", {
      kind: "task",
      title: "SECRET task",
      sourceExternalIds: ["gh:1"],
    });

    // First a plain forget (body purged, derived quote left behind).
    const first = sourceForget(store, { externalId: "gh:1" });
    expect(first.status).toBe("forgotten");
    expect(col("tasks", "title")).toBe("SECRET task");

    // Re-forget WITH cascade: status is already_forgotten but the derived redaction
    // still runs (so the operator can retrofit a cascade after a plain forget).
    const second = sourceForget(store, { externalId: "gh:1", cascade: true });
    expect(second.status).toBe("already_forgotten");
    expect(second.cascaded).toBe(true);
    expect(col("tasks", "title")).toBe(REDACTED_TEXT);
    expect(eventsContaining("SECRET")).toBe(0);
  });
});

describe("propose.reject summary redaction (ADR-0026 R1-3)", () => {
  test("rejecting a reply_draft candidate purges its full body from the ledger + event", () => {
    ingest("gh:1", "source");
    const cid = generateOnly("reply_draft", {
      kind: "reply_draft",
      body: "SECRET full reply body",
      replyToExternalId: "gh:1",
    });
    // The summary held the full reply body verbatim before rejection.
    expect(listProposals(sqlite(), {})[0]?.summary).toBe("SECRET full reply body");

    const out = proposeReject(store, { candidateId: cid, reason: "no thanks" });
    expect(out.status).toBe("rejected");

    // Acceptance (R1-3): the full text disappears from BOTH the ledger and the log.
    const rejected = listProposals(sqlite(), { state: "rejected" })[0];
    expect(rejected?.summary).toBe(REDACTED_TEXT);
    expect(rejected?.reason).toBe("no thanks"); // the reason is still recorded
    expect(eventField("ProposalGenerated", "$.summary")).toEqual([REDACTED_TEXT]);
    expect(eventsContaining("SECRET full reply body")).toBe(0);
  });

  test("reject summary redaction is replay-stable", () => {
    ingest("gh:1", "source");
    const cid = generateOnly("reply_draft", {
      kind: "reply_draft",
      body: "SECRET reply",
      replyToExternalId: "gh:1",
    });
    proposeReject(store, { candidateId: cid, reason: "x" });

    store.rebuild();
    expect(listProposals(sqlite(), { state: "rejected" })[0]?.summary).toBe(REDACTED_TEXT);
    expect(eventsContaining("SECRET reply")).toBe(0);
  });

  test("a no-op reject (missing / applied) does not redact anything", () => {
    ingest("gh:1", "source");
    // applied candidate — reject reports `applied` and must not touch the summary.
    const cid = generateApply("source_extract", {
      kind: "task",
      title: "keep me",
      sourceExternalIds: ["gh:1"],
    });
    expect(proposeReject(store, { candidateId: cid }).status).toBe("applied");
    expect(listProposals(sqlite(), {})[0]?.summary).toBe("keep me");
  });
});
