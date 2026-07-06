/**
 * Reject enforcement ([boundary/missed-reject] / ADR-0004): `propose.apply` and
 * `propose.batch` must consult the proposals ledger so a human's recorded "no"
 * cannot be silently overridden.
 *
 * Before this, apply/batch checked only domain projections — never the ledger —
 * so a `rejected` candidate applied cleanly, minting the entity while the ledger
 * row still read `rejected` (a self-contradicting audit trail). Now a rejected
 * candidateId is a structured `REJECTED_CANDIDATE` tool error; a candidate with
 * no ledger row (pure generate / direct create) is unaffected.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../../src/db/index.ts";
import { McpToolError } from "../../src/mcp/errors.ts";
import { listProposals } from "../../src/mcp/queries.ts";
import { proposalLedgerState, proposeApply } from "../../src/propose/apply.ts";
import { proposeBatch } from "../../src/propose/batch.ts";
import type { Candidate } from "../../src/propose/candidates.ts";
import { persistProposals, proposeGenerate } from "../../src/propose/generate.ts";
import { proposeReject } from "../../src/propose/reject.ts";

let store: Store;
beforeEach(() => {
  store = Store.open({ path: ":memory:" });
});
afterEach(() => {
  store.close();
});

const sqlite = () => store.connection.sqlite;

/** persist one task candidate to the ledger; return its stamped Candidate. */
function generate(title: string): Candidate {
  return persistProposals(store, {
    mode: "source_extract",
    candidates: [{ kind: "task", title }],
  }).candidates[0] as Candidate;
}

function reject(cand: Candidate): void {
  proposeReject(store, { candidateId: cand.candidateId, reason: "not now" });
}

function taskCount(): number {
  return sqlite().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tasks").get()?.n ?? -1;
}

describe("reject enforcement — apply/batch consult the ledger ([boundary/missed-reject])", () => {
  test("proposeApply refuses a rejected candidate with REJECTED_CANDIDATE (no entity, ledger unchanged)", () => {
    const cand = generate("reject me");
    reject(cand);
    expect(proposalLedgerState(store, cand.candidateId)).toBe("rejected");

    let err: unknown;
    try {
      proposeApply(store, { candidates: [cand] });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as McpToolError).code).toBe("REJECTED_CANDIDATE");

    // No domain entity created; the ledger row is still rejected (no self-contradiction).
    expect(taskCount()).toBe(0);
    expect(listProposals(sqlite(), { state: "rejected" })).toHaveLength(1);
    expect(listProposals(sqlite(), { state: "applied" })).toHaveLength(0);
  });

  test("the whole apply set is refused if ANY member is rejected (no partial apply)", () => {
    const ok = generate("apply me");
    const bad = generate("reject me");
    reject(bad);

    expect(() => proposeApply(store, { candidates: [ok, bad] })).toThrow(/rejected/i);
    // Pre-flight runs before any append: the valid candidate did NOT partially apply.
    expect(taskCount()).toBe(0);
    expect(listProposals(sqlite(), { state: "applied" })).toHaveLength(0);
  });

  test("proposeBatch rolls the whole atomic batch back when an apply op targets a rejected candidate", () => {
    const ok = generate("batch apply");
    const bad = generate("batch reject");
    reject(bad);

    expect(() =>
      proposeBatch(store, {
        operations: [
          { action: "apply", candidate: ok },
          { action: "apply", candidate: bad },
        ],
      }),
    ).toThrow(/rejected/i);
    // Atomic: neither op committed (single transaction rolled back).
    expect(taskCount()).toBe(0);
    expect(listProposals(sqlite(), { state: "applied" })).toHaveLength(0);
  });

  test("a candidate with NO ledger row applies normally (pure generate / direct-create path unaffected)", () => {
    // proposeGenerate is pure (no ledger append), so no proposals row exists.
    const cand = proposeGenerate({
      mode: "source_extract",
      candidates: [{ kind: "task", title: "no ledger row" }],
    }).candidates[0] as Candidate;
    expect(proposalLedgerState(store, cand.candidateId)).toBeNull();

    const out = proposeApply(store, { candidates: [cand] });
    expect(out.applied).toBe(1);
    expect(taskCount()).toBe(1);
  });

  test("an APPLIED candidate re-applies idempotently (skipped), not blocked as rejected", () => {
    const cand = generate("apply then reapply");
    expect(proposeApply(store, { candidates: [cand] }).applied).toBe(1);
    // The ledger flips to applied; re-apply is a no-op skip, never REJECTED_CANDIDATE.
    expect(proposalLedgerState(store, cand.candidateId)).toBe("applied");
    const again = proposeApply(store, { candidates: [cand] });
    expect(again.applied).toBe(0);
    expect(again.skipped).toBe(1);
  });
});
