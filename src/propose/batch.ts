/**
 * `propose.batch` — apply and/or reject HITL candidates in ONE RPC under a
 * single transaction boundary (Issue #197 / ADR-0004 / ADR-0002).
 *
 * The approve/reject HITL loop previously needed two RPCs (`propose.apply` +
 * `propose.reject`), each opening its own transaction. When a host has decided a
 * whole batch at once ("apply these, reject those"), that is both chatty and
 * non-atomic: a crash between the two RPCs leaves the ledger half-decided. This
 * tool folds the two into one operation list and commits it in a single
 * transaction so the batch is all-or-nothing.
 *
 * Each operation is a discriminated union over `action`:
 *   - `apply`  carries the full id-stamped `Candidate` (apply needs the payload
 *     to build the domain event; the ledger only stores summary/entity_id, so a
 *     candidateId alone is not enough — the host re-supplies the candidate from
 *     `propose.generate`, exactly as `propose.apply` requires).
 *   - `reject` carries just the `candidateId` + optional `reason` (reject acts on
 *     the ledger row, which is keyed by candidateId).
 *
 * The per-op decision logic is reused verbatim from `apply.ts` / `reject.ts`
 * (`applyCandidateStep` / `rejectCandidateStep`) — same idempotence and
 * state-dependent semantics — only the transaction boundary differs: the batch
 * wraps the whole loop in one `sqlite.transaction()`, so any thrown error
 * (e.g. an invalid candidate) rolls the entire batch back (no partial writes).
 */
import { z } from "zod";
import type { Store } from "../db/index.ts";
import { type AppliedCandidate, applyCandidateStep } from "./apply.ts";
import { Candidate as CandidateSchema } from "./candidates.ts";
import { type ProposeRejectOutput, rejectCandidateStep } from "./reject.ts";

/** An `apply` op: persist an approved, id-stamped candidate (reuses apply). */
const ApplyOp = z.object({
  action: z.literal("apply"),
  candidate: CandidateSchema,
});

/** A `reject` op: reject a pending candidate by id with an optional reason. */
const RejectOp = z.object({
  action: z.literal("reject"),
  candidateId: z.string().min(1),
  reason: z.string().default(""),
});

/** Input to `propose.batch`: a mixed list of apply/reject operations. */
export const ProposeBatchInput = z.object({
  operations: z.array(z.discriminatedUnion("action", [ApplyOp, RejectOp])).min(1),
});
/** Accepted at the call site (defaults applied by `parse`). */
export type ProposeBatchInput = z.input<typeof ProposeBatchInput>;

/** One batch result: an `apply` or a `reject` outcome, tagged by `action`. */
export type BatchResult =
  | ({ action: "apply" } & AppliedCandidate)
  | ({ action: "reject" } & ProposeRejectOutput);

export interface ProposeBatchOutput {
  results: BatchResult[];
  /** Candidates whose entity event was appended (apply, status=applied). */
  applied: number;
  /** Apply ops that were no-ops because the entity already existed. */
  skipped: number;
  /** Candidates flipped pending → rejected (reject, status=rejected). */
  rejected: number;
}

/**
 * Apply and/or reject candidates in one atomic transaction. Each op reuses the
 * same per-op logic as `propose.apply` / `propose.reject`; the only difference
 * is the shared transaction boundary (all-or-nothing). The host must have
 * obtained human approval before calling (HITL, no auto-apply — ADR-0004).
 */
export function proposeBatch(
  store: Store,
  input: ProposeBatchInput,
  now: Date = new Date(),
): ProposeBatchOutput {
  const { operations } = ProposeBatchInput.parse(input);

  const results = store.connection.sqlite.transaction((): BatchResult[] =>
    operations.map((op): BatchResult => {
      if (op.action === "apply") {
        return { action: "apply", ...applyCandidateStep(store, op.candidate, now) };
      }
      return { action: "reject", ...rejectCandidateStep(store, op.candidateId, op.reason, now) };
    }),
  )();

  let applied = 0;
  let skipped = 0;
  let rejected = 0;
  for (const r of results) {
    if (r.action === "apply") {
      if (r.status === "applied") applied += 1;
      else skipped += 1;
    } else if (r.status === "rejected") {
      rejected += 1;
    }
  }
  return { results, applied, skipped, rejected };
}
