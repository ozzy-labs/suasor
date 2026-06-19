/**
 * Commitment lifecycle write tools — `commitment.resolve` / `commitment.dismiss`
 * / `commitment.reopen` (ADR-0021 / docs/design/mcp-surface.md).
 *
 * The state-transition half of the commitment ledger: `commitment.list` reads
 * outstanding commitments, the propose pipeline (`commitment_scan` mode) extracts
 * and opens them, and these three write tools drive the HITL lifecycle over the
 * `commitments` projection:
 *   - `resolve` — mark an `open` commitment fulfilled  (→ `CommitmentResolved`)
 *   - `dismiss` — drop an `open` commitment (false-positive / no longer relevant,
 *                 → `CommitmentDismissed`)
 *   - `reopen`  — move a `resolved` / `dismissed` commitment back to `open`
 *                 (→ `CommitmentReopened`)
 *
 * All are HITL: the host gates them behind approval (`readOnlyHint: false`, no
 * auto-apply, ADR-0004). Each appends a domain event through `Store.record`
 * (append + fold, ADR-0002). Transitions are status-reporting (not thrown): a
 * no-op transition (already in the target state) is reported, an invalid one
 * (e.g. resolving a dismissed commitment) is reported as `invalid_state`, and a
 * missing commitment is reported `missing` — so the host can surface the outcome
 * without a crash, and replaying a redundant transition stays idempotent.
 */
import { z } from "zod";
import type { Store } from "../db/index.ts";

/** Input shared by every commitment transition tool. */
export const CommitmentTransitionInput = z.object({
  commitmentId: z.string().min(1),
});
/** Accepted at the call site. */
export type CommitmentTransitionInput = z.input<typeof CommitmentTransitionInput>;

/**
 * Outcome of a commitment transition:
 *   - `<applied>`     — the transition happened (event appended);
 *   - `<no-op>`       — the commitment was already in the target state (no event);
 *   - `invalid_state` — the current state does not permit this transition;
 *   - `missing`       — no commitment with that id exists.
 * Each tool's success/no-op labels are documented on its function below.
 */
export interface CommitmentTransitionOutput {
  commitmentId: string;
  status:
    | "resolved"
    | "dismissed"
    | "reopened"
    | "already_resolved"
    | "already_dismissed"
    | "already_open"
    | "invalid_state"
    | "missing";
  /** The commitment's state after the call (null when `missing`). */
  state: "open" | "resolved" | "dismissed" | null;
}

interface CommitmentStateRow {
  state: string;
}

/** Read the current state of a commitment, or `null` when it does not exist. */
function currentState(store: Store, commitmentId: string): string | null {
  const row = store.connection.sqlite
    .query<CommitmentStateRow, [string]>("SELECT state FROM commitments WHERE id = ?")
    .get(commitmentId);
  return row?.state ?? null;
}

/**
 * Resolve (fulfil) an `open` commitment (append `CommitmentResolved`). The host
 * must have human approval first. Idempotent: an already-`resolved` commitment is
 * a no-op (`already_resolved`); a `dismissed` one is `invalid_state` (reopen
 * first); a missing one is `missing`.
 */
export function commitmentResolve(
  store: Store,
  input: CommitmentTransitionInput,
  now: Date = new Date(),
): CommitmentTransitionOutput {
  const { commitmentId } = CommitmentTransitionInput.parse(input);
  const state = currentState(store, commitmentId);
  if (state === null) return { commitmentId, status: "missing", state: null };
  if (state === "resolved") return { commitmentId, status: "already_resolved", state: "resolved" };
  if (state !== "open") return { commitmentId, status: "invalid_state", state: "dismissed" };

  store.record({ type: "CommitmentResolved", commitmentId }, now);
  return { commitmentId, status: "resolved", state: "resolved" };
}

/**
 * Dismiss an `open` commitment (append `CommitmentDismissed`). Idempotent: an
 * already-`dismissed` one is a no-op (`already_dismissed`); a `resolved` one is
 * `invalid_state` (reopen first); a missing one is `missing`.
 */
export function commitmentDismiss(
  store: Store,
  input: CommitmentTransitionInput,
  now: Date = new Date(),
): CommitmentTransitionOutput {
  const { commitmentId } = CommitmentTransitionInput.parse(input);
  const state = currentState(store, commitmentId);
  if (state === null) return { commitmentId, status: "missing", state: null };
  if (state === "dismissed") {
    return { commitmentId, status: "already_dismissed", state: "dismissed" };
  }
  if (state !== "open") return { commitmentId, status: "invalid_state", state: "resolved" };

  store.record({ type: "CommitmentDismissed", commitmentId }, now);
  return { commitmentId, status: "dismissed", state: "dismissed" };
}

/**
 * Reopen a `resolved` / `dismissed` commitment back to `open` (append
 * `CommitmentReopened`). Idempotent: an already-`open` one is a no-op
 * (`already_open`); a missing one is `missing`.
 */
export function commitmentReopen(
  store: Store,
  input: CommitmentTransitionInput,
  now: Date = new Date(),
): CommitmentTransitionOutput {
  const { commitmentId } = CommitmentTransitionInput.parse(input);
  const state = currentState(store, commitmentId);
  if (state === null) return { commitmentId, status: "missing", state: null };
  if (state === "open") return { commitmentId, status: "already_open", state: "open" };

  store.record({ type: "CommitmentReopened", commitmentId }, now);
  return { commitmentId, status: "reopened", state: "open" };
}
