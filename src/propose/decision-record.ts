/**
 * `decision.record` — direct HITL decision recording (ADR-0004 /
 * docs/design/mcp-surface.md, Issue #88).
 *
 * The write half of the decision loop: `decision.list` reads recorded decisions,
 * and `decision.record` is the human's own "log this decision" path (the
 * decision-rationale skill surfaces the rationale the user dictates). It is HITL
 * — the host gates it behind approval (`readOnlyHint: false`, no auto-apply,
 * ADR-0004) — and appends a `DecisionRecorded` event that folds into the
 * `decisions` projection (ADR-0002).
 *
 * Idempotence mirrors `task.create` / `propose.apply`: the `decisionId` is
 * content-derived from the title + provenance (id.ts), so re-recording the same
 * decision upserts the same row rather than duplicating it; the result reports
 * whether the event was appended (`created`) or the decision already existed
 * (`existing`). The id is keyed on title + provenance only (matching the
 * `decision` candidate fingerprint), so a re-record with a changed `rationale`
 * is reported `existing` — the first recorded rationale wins.
 */
import { z } from "zod";
import type { Store } from "../db/index.ts";
import { entityId } from "./id.ts";

/** Input to `decision.record`. */
export const DecisionRecordInput = z.object({
  title: z.string().min(1),
  rationale: z.string().default(""),
  /** Source(s) this decision derives from (provenance → `links`). */
  sourceExternalIds: z.array(z.string().min(1)).default([]),
});
/** Accepted at the call site (defaults applied by `parse`). */
export type DecisionRecordInput = z.input<typeof DecisionRecordInput>;

export interface DecisionRecordOutput {
  decisionId: string;
  status: "created" | "existing";
}

/**
 * Record a decision (append `DecisionRecorded`). The host must have human
 * approval first. Idempotent on content: an existing decision with the derived
 * id is a no-op.
 */
export function decisionRecord(
  store: Store,
  input: DecisionRecordInput,
  now: Date = new Date(),
): DecisionRecordOutput {
  const { title, rationale, sourceExternalIds } = DecisionRecordInput.parse(input);
  // entityId derives the id from kind/title/sourceExternalIds (id.ts) — the same
  // function propose.apply uses for `decision` candidates, so the human path and
  // the model-suggested path land on the same projection row for equal content.
  const decisionId = entityId({
    kind: "decision",
    candidateId: "decision.record",
    title,
    rationale,
    sourceExternalIds,
  });

  const existing = store.connection.sqlite
    .query("SELECT 1 FROM decisions WHERE id = ?")
    .get(decisionId);
  if (existing !== null) {
    return { decisionId, status: "existing" };
  }

  store.record({ type: "DecisionRecorded", decisionId, title, rationale, sourceExternalIds }, now);
  return { decisionId, status: "created" };
}
