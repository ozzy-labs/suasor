/**
 * `persistProposals` decided-candidate annotation ([boundary/missed-reject]).
 *
 * `propose.generate` used to re-return an already-decided candidate (applied /
 * rejected) in `candidates` with no state marker, inviting the host to re-offer
 * a suggestion the human already declined. Now already-decided candidates are
 * withheld from the actionable `candidates` and surfaced separately in `decided`
 * with their ledger state (+reason).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../../src/db/index.ts";
import { proposeApply } from "../../src/propose/apply.ts";
import type { Candidate } from "../../src/propose/candidates.ts";
import { persistProposals } from "../../src/propose/generate.ts";
import { proposeReject } from "../../src/propose/reject.ts";

let store: Store;
beforeEach(() => {
  store = Store.open({ path: ":memory:" });
});
afterEach(() => {
  store.close();
});

function generate(title: string) {
  return persistProposals(store, {
    mode: "source_extract",
    candidates: [{ kind: "task", title }],
  });
}

/** Read a task candidate's title (union narrowing helper for assertions). */
function titleOf(c: Candidate): string {
  return c.kind === "task" ? c.title : "";
}

function proposalCount(): number {
  return (
    store.connection.sqlite.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM proposals").get()
      ?.n ?? -1
  );
}

describe("persistProposals — decided annotation ([boundary/missed-reject])", () => {
  test("a freshly generated candidate is pending: in `candidates`, no `decided`", () => {
    const out = generate("fresh");
    expect(out.candidates).toHaveLength(1);
    expect(out.decided).toBeUndefined();
  });

  test("re-generating a still-pending candidate keeps it actionable (no decided, no duplicate ledger row)", () => {
    const cand = generate("dup").candidates[0] as Candidate;
    const second = generate("dup");
    expect(second.candidates).toHaveLength(1);
    expect(second.candidates[0]?.candidateId).toBe(cand.candidateId);
    expect(second.decided).toBeUndefined();
    expect(proposalCount()).toBe(1); // idempotent: no redundant ProposalGenerated
  });

  test("re-generating a REJECTED candidate annotates it decided and drops it from candidates", () => {
    const cand = generate("rejected").candidates[0] as Candidate;
    proposeReject(store, { candidateId: cand.candidateId, reason: "no thanks" });

    const again = generate("rejected");
    expect(again.candidates).toHaveLength(0);
    expect(again.decided).toHaveLength(1);
    expect(again.decided?.[0]).toMatchObject({
      candidateId: cand.candidateId,
      kind: "task",
      state: "rejected",
      reason: "no thanks",
    });
  });

  test("re-generating an APPLIED candidate annotates it decided (state applied)", () => {
    const cand = generate("applied").candidates[0] as Candidate;
    proposeApply(store, { candidates: [cand] });

    const again = generate("applied");
    expect(again.candidates).toHaveLength(0);
    expect(again.decided?.[0]).toMatchObject({ candidateId: cand.candidateId, state: "applied" });
  });

  test("a multi-candidate generate splits pending vs decided in one call", () => {
    // Seed both, reject one.
    const seed = persistProposals(store, {
      mode: "source_extract",
      candidates: [
        { kind: "task", title: "keep" },
        { kind: "task", title: "reject" },
      ],
    });
    const toReject = seed.candidates.find((c) => titleOf(c) === "reject") as Candidate;
    proposeReject(store, { candidateId: toReject.candidateId });

    const out = persistProposals(store, {
      mode: "source_extract",
      candidates: [
        { kind: "task", title: "keep" },
        { kind: "task", title: "reject" },
      ],
    });
    expect(out.candidates.map(titleOf)).toEqual(["keep"]);
    expect(out.decided?.map((d) => d.state)).toEqual(["rejected"]);
  });
});
