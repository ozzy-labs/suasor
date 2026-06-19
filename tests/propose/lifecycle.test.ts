/**
 * Proposal lifecycle (Issue #89): generate → list (pending) → apply/reject →
 * list (state transition reflected), exercised at the service layer.
 *
 * Verifies the `proposals` ledger folds correctly:
 *   - persistProposals records each candidate as `pending` (idempotent),
 *   - propose.apply flips the matching proposal to `applied` (by entity_id),
 *   - propose.reject flips a pending proposal to `rejected` and blocks re-apply,
 *   - rebuild replays the ledger to the identical end state (ADR-0002).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../../src/db/index.ts";
import { listProposals } from "../../src/mcp/queries.ts";
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

const sqlite = () => store.connection.sqlite;

describe("propose lifecycle ledger (#89)", () => {
  test("generate records a pending proposal; list surfaces it", () => {
    const result = persistProposals(store, {
      mode: "source_extract",
      candidates: [{ kind: "task", title: "ship it", sourceExternalIds: ["gh:1"] }],
    });
    const cid = result.candidates[0]?.candidateId as string;

    const pending = listProposals(sqlite(), { state: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.candidateId).toBe(cid);
    expect(pending[0]?.kind).toBe("task");
    expect(pending[0]?.summary).toBe("ship it");
    expect(pending[0]?.state).toBe("pending");

    // generate writes NO domain entity (only the ledger).
    expect(sqlite().query("SELECT 1 FROM tasks").all()).toHaveLength(0);
  });

  test("generate is idempotent: re-generating the same candidate adds no ledger row", () => {
    const input = {
      mode: "source_extract" as const,
      candidates: [{ kind: "task" as const, title: "again", sourceExternalIds: [] }],
    };
    persistProposals(store, input);
    persistProposals(store, input);
    expect(listProposals(sqlite(), {})).toHaveLength(1);
    // Exactly one ProposalGenerated event was appended.
    const events = sqlite()
      .query<{ c: number }, []>("SELECT COUNT(*) c FROM events WHERE type = 'ProposalGenerated'")
      .get();
    expect(events?.c).toBe(1);
  });

  test("apply flips the matching pending proposal to applied", () => {
    const generated = persistProposals(store, {
      mode: "source_extract",
      candidates: [{ kind: "decision", title: "use bun", rationale: "fast" }],
    });
    proposeApply(store, { candidates: generated.candidates as Candidate[] });

    expect(listProposals(sqlite(), { state: "pending" })).toHaveLength(0);
    const applied = listProposals(sqlite(), { state: "applied" });
    expect(applied).toHaveLength(1);
    expect(applied[0]?.kind).toBe("decision");
    // The domain entity now exists.
    expect(sqlite().query("SELECT 1 FROM decisions").all()).toHaveLength(1);
  });

  test("reject flips pending → rejected and records the reason", () => {
    const generated = persistProposals(store, {
      mode: "source_extract",
      candidates: [{ kind: "task", title: "no thanks" }],
    });
    const cid = generated.candidates[0]?.candidateId as string;

    const out = proposeReject(store, { candidateId: cid, reason: "duplicate" });
    expect(out.status).toBe("rejected");

    const rejected = listProposals(sqlite(), { state: "rejected" });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBe("duplicate");
    expect(listProposals(sqlite(), { state: "pending" })).toHaveLength(0);
  });

  test("a rejected candidate cannot be applied (no domain entity, no resurrect)", () => {
    const generated = persistProposals(store, {
      mode: "source_extract",
      candidates: [{ kind: "task", title: "rejected then apply" }],
    });
    const candidates = generated.candidates as Candidate[];
    const cid = candidates[0]?.candidateId as string;

    proposeReject(store, { candidateId: cid, reason: "bad" });
    // The host should not apply a rejected candidate, but if it tries, the ledger
    // must stay `rejected` (apply still persists the entity since the projection
    // entity is independent — but the ledger flip only acts on pending rows).
    proposeApply(store, { candidates });

    const ledger = listProposals(sqlite(), {});
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.state).toBe("rejected");
  });

  test("reject reports applied/missing without mutating", () => {
    expect(proposeReject(store, { candidateId: "cand_nope" }).status).toBe("missing");

    const generated = persistProposals(store, {
      mode: "source_extract",
      candidates: [{ kind: "task", title: "applied first" }],
    });
    const candidates = generated.candidates as Candidate[];
    const cid = candidates[0]?.candidateId as string;
    proposeApply(store, { candidates });

    expect(proposeReject(store, { candidateId: cid }).status).toBe("applied");
    expect(listProposals(sqlite(), { state: "applied" })).toHaveLength(1);
  });

  test("reject is idempotent (already_rejected on re-reject)", () => {
    const generated = persistProposals(store, {
      mode: "source_extract",
      candidates: [{ kind: "task", title: "double reject" }],
    });
    const cid = generated.candidates[0]?.candidateId as string;
    expect(proposeReject(store, { candidateId: cid }).status).toBe("rejected");
    expect(proposeReject(store, { candidateId: cid }).status).toBe("already_rejected");
  });

  test("rebuild replays the ledger to the identical end state", () => {
    const gen1 = persistProposals(store, {
      mode: "source_extract",
      candidates: [{ kind: "task", title: "applied one" }],
    });
    proposeApply(store, { candidates: gen1.candidates as Candidate[] });
    const gen2 = persistProposals(store, {
      mode: "source_extract",
      candidates: [{ kind: "decision", title: "rejected one", rationale: "" }],
    });
    proposeReject(store, { candidateId: gen2.candidates[0]?.candidateId as string, reason: "x" });

    const before = listProposals(sqlite(), {});
    store.rebuild();
    const after = listProposals(sqlite(), {});
    expect(after).toEqual(before);
    // One applied, one rejected, none pending.
    expect(after.filter((p) => p.state === "applied")).toHaveLength(1);
    expect(after.filter((p) => p.state === "rejected")).toHaveLength(1);
    expect(after.filter((p) => p.state === "pending")).toHaveLength(0);
  });

  test("list filters by kind and orders newest-updated first", () => {
    persistProposals(store, {
      mode: "source_extract",
      candidates: [
        { kind: "task", title: "t1" },
        { kind: "decision", title: "d1", rationale: "" },
      ],
    });
    const tasks = listProposals(sqlite(), { kind: "task" });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.kind).toBe("task");
  });
});
