/**
 * Demand seen-state services behind the `demand.mark` write tool (ADR-0041 /
 * docs/design/mcp-surface.md).
 *
 * Demand rows are *derived* (from ingested `slack_message` @mentions / DMs and
 * `github_notification` threads, ADR-0012 / ADR-0041), not stored entities, so
 * "I've dealt with this" cannot be a lifecycle transition on an entity. Instead
 * these two write tools append a seen event keyed by the source `externalId`:
 *   - `ack`     — "handled"       (→ `DemandAcknowledged`, state `acked`)
 *   - `dismiss` — "not relevant"  (→ `DemandDismissed`,     state `dismissed`)
 * Both fold into the `demand_seen` projection (last-write-wins), and `demand.list`
 * hides a seen row by default — so "unprocessed" is finally true rather than every
 * ingested mention living forever at the top of next-actions (ADR-0012 決定 4's
 * host-delegated seen-marker is superseded; state lives in the event log, ADR-0002).
 *
 * Both are HITL: the host gates them behind approval (`readOnlyHint: false`, no
 * auto-apply, ADR-0004). Each appends through `Store.record` (append + fold).
 * Status-reporting (not thrown): a no-op (already in the target state) is
 * reported, and an unknown source (nothing to mark seen) is reported `missing` —
 * so the host can surface the outcome without a crash, and replaying a redundant
 * mark stays idempotent (the reducer upsert is last-write-wins).
 */
import { z } from "zod";
import type { Store } from "../db/index.ts";

/** Input shared by both demand seen-state tools: the demand row's source id. */
export const DemandSeenInput = z.object({
  externalId: z.string().min(1),
});
/** Accepted at the call site. */
export type DemandSeenInput = z.input<typeof DemandSeenInput>;

/**
 * Outcome of a demand seen-state write:
 *   - `acked` / `dismissed`                 — the mark was appended (state changed);
 *   - `already_acked` / `already_dismissed` — already in that state (no event);
 *   - `missing`                             — no source with that `externalId`.
 */
export interface DemandSeenOutput {
  externalId: string;
  status: "acked" | "dismissed" | "already_acked" | "already_dismissed" | "missing";
  /** Seen-state after the call (null when `missing`). */
  seenState: "acked" | "dismissed" | null;
}

/** Does a source with this `externalId` exist (the demand row's provenance)? */
function sourceExists(store: Store, externalId: string): boolean {
  const row = store.connection.sqlite
    .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM sources WHERE external_id = ?")
    .get(externalId);
  return (row?.n ?? 0) > 0;
}

/** Current seen-state of a demand row, or `null` when it has never been marked. */
function currentSeen(store: Store, externalId: string): "acked" | "dismissed" | null {
  const row = store.connection.sqlite
    .query<{ state: string }, [string]>("SELECT state FROM demand_seen WHERE external_id = ?")
    .get(externalId);
  const state = row?.state ?? null;
  return state === "acked" || state === "dismissed" ? state : null;
}

/**
 * Acknowledge a demand row — "I have handled this" (append `DemandAcknowledged`).
 * The host must have human approval first. Idempotent: an already-`acked` row is a
 * no-op (`already_acked`); a `dismissed` row is re-marked `acked` (a valid "I did
 * handle it after all" correction — last-write-wins); an unknown source is
 * `missing`.
 */
export function demandAck(
  store: Store,
  input: DemandSeenInput,
  now: Date = new Date(),
): DemandSeenOutput {
  const { externalId } = DemandSeenInput.parse(input);
  if (!sourceExists(store, externalId)) return { externalId, status: "missing", seenState: null };
  if (currentSeen(store, externalId) === "acked") {
    return { externalId, status: "already_acked", seenState: "acked" };
  }
  store.record({ type: "DemandAcknowledged", externalId }, now);
  return { externalId, status: "acked", seenState: "acked" };
}

/**
 * Dismiss a demand row — "this needs no action from me" (append
 * `DemandDismissed`). Idempotent: an already-`dismissed` row is a no-op
 * (`already_dismissed`); an `acked` row is re-marked `dismissed`
 * (last-write-wins); an unknown source is `missing`.
 */
export function demandDismiss(
  store: Store,
  input: DemandSeenInput,
  now: Date = new Date(),
): DemandSeenOutput {
  const { externalId } = DemandSeenInput.parse(input);
  if (!sourceExists(store, externalId)) return { externalId, status: "missing", seenState: null };
  if (currentSeen(store, externalId) === "dismissed") {
    return { externalId, status: "already_dismissed", seenState: "dismissed" };
  }
  store.record({ type: "DemandDismissed", externalId }, now);
  return { externalId, status: "dismissed", seenState: "dismissed" };
}
