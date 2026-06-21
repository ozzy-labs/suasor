/**
 * `proposal.feedback` service (Issue #279): record a regeneration hint on a
 * pending candidate WITHOUT changing its lifecycle state.
 *
 * Verifies the ProposalFeedback event folds correctly into the proposals ledger:
 *   - feedback records the reason and keeps the candidate `pending`,
 *   - re-recording overwrites the reason (latest wins),
 *   - feedback on an applied/rejected/missing candidate is reported, not mutated,
 *   - the event is persisted (idempotency/replay-stable: rebuild → same state).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../../src/db/index.ts";
import { listProposals } from "../../src/mcp/queries.ts";
import { proposeApply } from "../../src/propose/apply.ts";
import type { Candidate } from "../../src/propose/candidates.ts";
import { proposeFeedback } from "../../src/propose/feedback.ts";
import { persistProposals } from "../../src/propose/generate.ts";
import { proposeReject } from "../../src/propose/reject.ts";

let store: Store;

beforeEach(() => {
  store = Store.open({ path: ":memory:" });
});

afterEach(() => {
  store.close();
});

const sqlite = () => store.connection.sqlite;

/** Generate one pending task candidate and return its candidate id. */
function generatePending(title = "draft me"): string {
  const result = persistProposals(store, {
    mode: "source_extract",
    candidates: [{ kind: "task", title }],
  });
  return result.candidates[0]?.candidateId as string;
}

describe("proposal.feedback (#279)", () => {
  test("records the reason and keeps the candidate pending", () => {
    const cid = generatePending();
    const out = proposeFeedback(store, { candidateId: cid, reason: "make it shorter" });
    expect(out.status).toBe("recorded");

    const pending = listProposals(sqlite(), { state: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.candidateId).toBe(cid);
    expect(pending[0]?.state).toBe("pending");
    expect(pending[0]?.reason).toBe("make it shorter");

    // A ProposalFeedback event was persisted.
    const events = sqlite()
      .query<{ c: number }, []>("SELECT COUNT(*) c FROM events WHERE type = 'ProposalFeedback'")
      .get();
    expect(events?.c).toBe(1);
  });

  test("re-recording overwrites the reason (latest wins), still pending", () => {
    const cid = generatePending();
    expect(proposeFeedback(store, { candidateId: cid, reason: "first" }).status).toBe("recorded");
    expect(proposeFeedback(store, { candidateId: cid, reason: "second" }).status).toBe("recorded");

    const pending = listProposals(sqlite(), { state: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.reason).toBe("second");

    const events = sqlite()
      .query<{ c: number }, []>("SELECT COUNT(*) c FROM events WHERE type = 'ProposalFeedback'")
      .get();
    expect(events?.c).toBe(2);
  });

  test("a candidate that took feedback can still be applied", () => {
    const result = persistProposals(store, {
      mode: "source_extract",
      candidates: [{ kind: "decision", title: "ship", rationale: "" }],
    });
    const candidates = result.candidates as Candidate[];
    const cid = candidates[0]?.candidateId as string;

    proposeFeedback(store, { candidateId: cid, reason: "add rationale" });
    proposeApply(store, { candidates });

    const applied = listProposals(sqlite(), { state: "applied" });
    expect(applied).toHaveLength(1);
    expect(applied[0]?.candidateId).toBe(cid);
    expect(sqlite().query("SELECT 1 FROM decisions").all()).toHaveLength(1);
  });

  test("reports applied / rejected / missing without mutating", () => {
    // missing
    expect(proposeFeedback(store, { candidateId: "cand_nope", reason: "x" }).status).toBe(
      "missing",
    );

    // applied
    const g1 = persistProposals(store, {
      mode: "source_extract",
      candidates: [{ kind: "task", title: "applied" }],
    });
    const applied = g1.candidates as Candidate[];
    proposeApply(store, { candidates: applied });
    expect(
      proposeFeedback(store, { candidateId: applied[0]?.candidateId as string, reason: "x" })
        .status,
    ).toBe("applied");

    // rejected
    const cid = generatePending("rejected one");
    proposeReject(store, { candidateId: cid, reason: "no" });
    expect(proposeFeedback(store, { candidateId: cid, reason: "x" }).status).toBe("rejected");
    // The rejection reason is not clobbered by the refused feedback.
    expect(listProposals(sqlite(), { state: "rejected" })[0]?.reason).toBe("no");
  });

  test("rebuild replays feedback to the identical end state", () => {
    const cid = generatePending();
    proposeFeedback(store, { candidateId: cid, reason: "tweak" });

    const before = listProposals(sqlite(), {});
    store.rebuild();
    const after = listProposals(sqlite(), {});
    expect(after).toEqual(before);
    expect(after[0]?.state).toBe("pending");
    expect(after[0]?.reason).toBe("tweak");
  });
});
