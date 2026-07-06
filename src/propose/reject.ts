/**
 * `propose.reject` — reject a pending HITL proposal candidate (Issue #89).
 *
 * The missing half of the approve/reject loop: where `propose.apply` persists an
 * approved candidate, `propose.reject` records a human's decision to NOT apply
 * one, flipping its `proposals` ledger row to `rejected` (with a reason). It is a
 * write tool (HITL, `readOnlyHint: false`, no auto-apply — ADR-0004) that appends
 * a `ProposalRejected` event (ADR-0002).
 *
 * Reject acts only on a still-`pending` candidate: an already-applied proposal
 * stays `applied` (its entity is persisted; reject must not "un-apply" it), and a
 * candidate id with no ledger row is reported `missing`. Re-rejecting an
 * already-rejected candidate is a no-op (`already_rejected`). This makes a
 * rejected candidate un-appliable — `propose.list` no longer surfaces it as
 * pending, so the host won't re-offer it for approval.
 *
 * Reject also redacts the candidate's `ProposalGenerated.summary` (ADR-0026 R1-3):
 * a reply_draft candidate's summary is its full body, so a human's rejection must
 * purge that verbatim quote from the ledger + event log rather than retain a
 * draft the user explicitly discarded. This is the source-of-leak fix and applies
 * independently of `source.forget`.
 */
import { z } from "zod";
import type { Store } from "../db/index.ts";
import { appendEvent } from "../events/store.ts";
import { redactProposalSummary } from "../forget/cascade.ts";
import { applyEvent } from "../projections/reducer.ts";

/** Input to `propose.reject`. */
export const ProposeRejectInput = z.object({
  candidateId: z.string().min(1),
  reason: z.string().default(""),
});
/** Accepted at the call site (defaults applied by `parse`). */
export type ProposeRejectInput = z.input<typeof ProposeRejectInput>;

export interface ProposeRejectOutput {
  candidateId: string;
  /**
   * `rejected`          — the pending candidate was rejected (event appended);
   * `already_rejected`  — it was already rejected (no event, idempotent no-op);
   * `applied`           — it was already applied and cannot be rejected;
   * `missing`           — no proposal with that candidate id exists.
   */
  status: "rejected" | "already_rejected" | "applied" | "missing";
}

interface ProposalStateRow {
  state: string;
}

/**
 * Reject one pending candidate WITHOUT opening its own transaction (cf.
 * `proposeReject`, which records via `store.record`'s per-event transaction).
 * The caller owns the transaction boundary — `propose.batch`
 * (src/propose/batch.ts) wraps a whole mixed apply/reject set in a single
 * transaction and calls this per reject op so the batch is atomic (Issue #197).
 *
 * Same state-dependent contract as `proposeReject`: rejects only a `pending`
 * row; `applied` / `missing` / `already_rejected` are reported, not mutated.
 */
export function rejectCandidateStep(
  store: Store,
  candidateId: string,
  reason: string,
  now: Date,
): ProposeRejectOutput {
  const row = store.connection.sqlite
    .query<ProposalStateRow, [string]>("SELECT state FROM proposals WHERE candidate_id = ?")
    .get(candidateId);

  if (row === null) return { candidateId, status: "missing" };
  if (row.state === "rejected") return { candidateId, status: "already_rejected" };
  if (row.state === "applied") return { candidateId, status: "applied" };

  const persisted = appendEvent(
    store.connection.sqlite,
    { type: "ProposalRejected", candidateId, reason },
    now,
  );
  applyEvent(store.connection.sqlite, persisted);
  // Summary redaction (ADR-0026 R1-3): a rejected candidate's
  // ProposalGenerated.summary can hold verbatim source content (a reply_draft's
  // full body), so a human's rejection must also purge that quote from the ledger
  // + event log — otherwise the rejected draft lingers. Independent of forget;
  // runs inside the caller's transaction so it is atomic with the reject.
  redactProposalSummary(store.connection.sqlite, candidateId, now);
  return { candidateId, status: "rejected" };
}

/**
 * Reject a pending proposal candidate (append `ProposalRejected`). The host must
 * have human approval/decision first. Idempotent on an already-rejected row.
 */
export function proposeReject(
  store: Store,
  input: ProposeRejectInput,
  now: Date = new Date(),
): ProposeRejectOutput {
  const { candidateId, reason } = ProposeRejectInput.parse(input);
  return store.connection.sqlite.transaction(() =>
    rejectCandidateStep(store, candidateId, reason, now),
  )();
}
