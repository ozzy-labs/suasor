/**
 * `propose.batch` (Issue #197): apply + reject in one atomic RPC.
 *
 * Exercises the service layer (src/propose/batch.ts):
 *   - a mixed apply/reject batch reuses the per-op apply/reject semantics,
 *   - the ledger reflects both transitions (applied / rejected) after one call,
 *   - idempotent apply (existing entity → skipped) and state-dependent reject
 *     (applied/missing reported, not mutated) carry over unchanged,
 *   - the whole batch commits under a single transaction (all-or-nothing): a
 *     thrown op rolls every preceding op in the same call back.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../../src/db/index.ts";
import { listProposals } from "../../src/mcp/queries.ts";
import { proposeApply } from "../../src/propose/apply.ts";
import { proposeBatch } from "../../src/propose/batch.ts";
import type { Candidate } from "../../src/propose/candidates.ts";
import { persistProposals } from "../../src/propose/generate.ts";

let store: Store;

beforeEach(() => {
  store = Store.open({ path: ":memory:" });
});

afterEach(() => {
  store.close();
});

const sqlite = () => store.connection.sqlite;

/** generate one candidate via the ledger; return its stamped Candidate. */
function generate(
  mode: Parameters<typeof persistProposals>[1]["mode"],
  candidate: Parameters<typeof persistProposals>[1]["candidates"][number],
): Candidate {
  const out = persistProposals(store, { mode, candidates: [candidate] });
  return out.candidates[0] as Candidate;
}

function countEvents(): number {
  return sqlite().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()?.n ?? -1;
}

describe("propose.batch — mixed apply/reject in one RPC (#197)", () => {
  test("applies one candidate and rejects another in a single call", () => {
    const toApply = generate("source_extract", { kind: "task", title: "do it" });
    const toReject = generate("source_extract", { kind: "task", title: "skip it" });

    const out = proposeBatch(store, {
      operations: [
        { action: "apply", candidate: toApply },
        { action: "reject", candidateId: toReject.candidateId, reason: "duplicate" },
      ],
    });

    expect(out.applied).toBe(1);
    expect(out.rejected).toBe(1);
    expect(out.skipped).toBe(0);
    expect(out.results).toHaveLength(2);

    // Apply flipped its ledger row to applied + persisted the task entity.
    const applied = listProposals(sqlite(), { state: "applied" });
    expect(applied).toHaveLength(1);
    expect(applied[0]?.candidateId).toBe(toApply.candidateId);
    expect(sqlite().query("SELECT 1 FROM tasks").all()).toHaveLength(1);

    // Reject flipped its ledger row to rejected with the reason.
    const rejected = listProposals(sqlite(), { state: "rejected" });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.candidateId).toBe(toReject.candidateId);
    expect(rejected[0]?.reason).toBe("duplicate");
  });

  test("apply op is idempotent: an existing entity is skipped (no event)", () => {
    const cand = generate("meeting_followup", { kind: "decision", title: "use bun" });
    proposeApply(store, { candidates: [cand] });
    const before = countEvents();

    const out = proposeBatch(store, {
      operations: [{ action: "apply", candidate: cand }],
    });
    expect(out.applied).toBe(0);
    expect(out.skipped).toBe(1);
    expect(out.results[0]).toMatchObject({ action: "apply", status: "skipped" });
    // No new event appended for the skipped (already-applied) candidate.
    expect(countEvents()).toBe(before);
  });

  test("reject op reports applied/missing without mutating", () => {
    const applied = generate("source_extract", { kind: "task", title: "already applied" });
    proposeApply(store, { candidates: [applied] });

    const out = proposeBatch(store, {
      operations: [
        { action: "reject", candidateId: applied.candidateId },
        { action: "reject", candidateId: "cand_nope" },
      ],
    });
    expect(out.rejected).toBe(0);
    expect(out.results[0]).toMatchObject({ action: "reject", status: "applied" });
    expect(out.results[1]).toMatchObject({ action: "reject", status: "missing" });
    // The applied ledger row is untouched.
    expect(listProposals(sqlite(), { state: "applied" })).toHaveLength(1);
  });

  test("the batch is atomic: an invalid op aborts the whole call (no partial writes)", () => {
    const ok = generate("source_extract", { kind: "task", title: "ok one" });
    const before = countEvents();

    // Input is validated up-front (ProposeBatchInput.parse), so an invalid
    // candidate (empty title) throws before any op executes; combined with the
    // single transaction boundary, the batch is all-or-nothing — the valid
    // preceding op leaves no event behind.
    expect(() =>
      proposeBatch(store, {
        operations: [
          { action: "apply", candidate: ok },
          // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid input
          { action: "apply", candidate: { kind: "task", title: "", candidateId: "x" } as any },
        ],
      }),
    ).toThrow();

    // Nothing committed: no new events, the first candidate's task absent.
    expect(countEvents()).toBe(before);
    expect(sqlite().query("SELECT 1 FROM tasks").all()).toHaveLength(0);
    expect(listProposals(sqlite(), { state: "applied" })).toHaveLength(0);
  });

  test("rebuild replays a batched ledger to the identical end state", () => {
    const a = generate("source_extract", { kind: "task", title: "applied via batch" });
    const r = generate("source_extract", { kind: "task", title: "rejected via batch" });
    proposeBatch(store, {
      operations: [
        { action: "apply", candidate: a },
        { action: "reject", candidateId: r.candidateId, reason: "no" },
      ],
    });

    const before = listProposals(sqlite(), {});
    store.rebuild();
    const after = listProposals(sqlite(), {});
    expect(after).toEqual(before);
  });
});
