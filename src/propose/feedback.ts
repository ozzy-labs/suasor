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
 * Record feedback on a pending proposal candidate (append `ProposalFeedback`).
 * The host must have human input first. Re-recording overwrites the prior
 * feedback reason (latest note wins); the candidate stays `pending`.
 *
 * State-dependent: records only on a `pending` row; an `applied` / `rejected`
 * candidate is decided and `missing` means no such ledger row — all three are
 * reported in the result, not mutated. The SELECT-then-append runs in a single
 * transaction so the state check and the event append are atomic. (Unlike
 * apply/reject there is no `*Step` variant: `proposal.feedback` is not part of
 * `propose.batch`, so it needs no transaction-less composable step.)
 */
export function proposeFeedback(
  store: Store,
  input: ProposeFeedbackInput,
  now: Date = new Date(),
): ProposeFeedbackOutput {
  const { candidateId, reason } = ProposeFeedbackInput.parse(input);
  const sqlite = store.connection.sqlite;
  return sqlite.transaction(() => {
    const row = sqlite
      .query<ProposalStateRow, [string]>("SELECT state FROM proposals WHERE candidate_id = ?")
      .get(candidateId);

    if (row === null) return { candidateId, status: "missing" } as const;
    if (row.state === "applied") return { candidateId, status: "applied" } as const;
    if (row.state === "rejected") return { candidateId, status: "rejected" } as const;

    const persisted = appendEvent(sqlite, { type: "ProposalFeedback", candidateId, reason }, now);
    applyEvent(sqlite, persisted);
    return { candidateId, status: "recorded" } as const;
  })();
}
