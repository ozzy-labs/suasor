/**
 * `proposal.feedback` — record a regeneration hint on a pending HITL candidate
 * (Issue #279).
 *
 * The third option beyond apply/reject: where `propose.apply` accepts a candidate
 * and `propose.reject` discards it, `proposal.feedback` records a human's note
 * ("修正して再生成") so the next `propose.generate` can use it as a hint. It is a
 * write tool (HITL, `readOnlyHint: false`, no auto-apply — ADR-0004) that appends
 * a `ProposalFeedback` event (ADR-0002).
 *
 * Feedback acts only on a still-`pending` candidate and, unlike reject, does NOT
 * change its lifecycle state — the candidate stays `pending` (still
 * appliable/rejectable); only the ledger row's `reason` is updated to the latest
 * note. An already-applied/rejected candidate is decided (reported, not mutated),
 * and a candidate id with no ledger row is reported `missing`.
 */
import { z } from "zod";
import type { Store } from "../db/index.ts";
import { appendEvent } from "../events/store.ts";
import { applyEvent } from "../projections/reducer.ts";

/** Input to `proposal.feedback`. */
export const ProposeFeedbackInput = z.object({
  candidateId: z.string().min(1),
  reason: z.string().min(1),
});
/** Accepted at the call site. */
export type ProposeFeedbackInput = z.input<typeof ProposeFeedbackInput>;

export interface ProposeFeedbackOutput {
  candidateId: string;
  /**
   * `recorded`  — the pending candidate's feedback reason was recorded (event appended);
   * `applied`   — it was already applied and cannot take feedback;
   * `rejected`  — it was already rejected and cannot take feedback;
   * `missing`   — no proposal with that candidate id exists.
   */
  status: "recorded" | "applied" | "rejected" | "missing";
}

interface ProposalStateRow {
  state: string;
}

/**
 * Record feedback for one pending candidate WITHOUT opening its own transaction
 * (cf. `proposeFeedback`, which wraps this in `sqlite.transaction`). Same
 * state-dependent contract: records only on a `pending` row; `applied` /
 * `rejected` / `missing` are reported, not mutated.
 */
export function feedbackCandidateStep(
  store: Store,
  candidateId: string,
  reason: string,
  now: Date,
): ProposeFeedbackOutput {
  const row = store.connection.sqlite
    .query<ProposalStateRow, [string]>("SELECT state FROM proposals WHERE candidate_id = ?")
    .get(candidateId);

  if (row === null) return { candidateId, status: "missing" };
  if (row.state === "applied") return { candidateId, status: "applied" };
  if (row.state === "rejected") return { candidateId, status: "rejected" };

  const persisted = appendEvent(
    store.connection.sqlite,
    { type: "ProposalFeedback", candidateId, reason },
    now,
  );
  applyEvent(store.connection.sqlite, persisted);
  return { candidateId, status: "recorded" };
}

/**
 * Record feedback on a pending proposal candidate (append `ProposalFeedback`).
 * The host must have human input first. Re-recording overwrites the prior
 * feedback reason (latest note wins); the candidate stays `pending`.
 */
export function proposeFeedback(
  store: Store,
  input: ProposeFeedbackInput,
  now: Date = new Date(),
): ProposeFeedbackOutput {
  const { candidateId, reason } = ProposeFeedbackInput.parse(input);
  return store.connection.sqlite.transaction(() =>
    feedbackCandidateStep(store, candidateId, reason, now),
  )();
}
