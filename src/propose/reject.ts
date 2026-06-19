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
 */
import { z } from "zod";
import type { Store } from "../db/index.ts";

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
 * Reject a pending proposal candidate (append `ProposalRejected`). The host must
 * have human approval/decision first. Idempotent on an already-rejected row.
 */
export function proposeReject(
  store: Store,
  input: ProposeRejectInput,
  now: Date = new Date(),
): ProposeRejectOutput {
  const { candidateId, reason } = ProposeRejectInput.parse(input);
  const row = store.connection.sqlite
    .query<ProposalStateRow, [string]>("SELECT state FROM proposals WHERE candidate_id = ?")
    .get(candidateId);

  if (row === null) return { candidateId, status: "missing" };
  if (row.state === "rejected") return { candidateId, status: "already_rejected" };
  if (row.state === "applied") return { candidateId, status: "applied" };

  store.record({ type: "ProposalRejected", candidateId, reason }, now);
  return { candidateId, status: "rejected" };
}
