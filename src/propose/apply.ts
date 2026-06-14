/**
 * `propose.apply` — persist approved candidates as domain events (ADR-0004 /
 * FR-PRO-2 / docs/design/mcp-surface.md).
 *
 * This is the only path that turns a proposal into stored state, and it runs
 * only after a human has approved the specific candidates (the host gates it via
 * `readOnlyHint: false`; there is no auto-apply path, ADR-0004). Each candidate
 * kind maps 1:1 to a domain event appended through `Store.record` (append + fold
 * in one transaction, ADR-0002):
 *   - `task`        → `TaskProposed`
 *   - `decision`    → `DecisionRecorded`
 *   - `reply_draft` → `ReplyDraftProposed`
 *   - `triage`      → `InboxItemTriaged`
 *
 * Idempotence (the issue's acceptance criterion): each candidate's target entity
 * id is content-derived (id.ts), and apply first checks the projection for that
 * id — if it already exists, the candidate is reported `skipped` and NO event is
 * appended, so re-applying the same approved set is a no-op (no duplicate events,
 * no projection drift). This keeps the append-only log free of redundant entries
 * while staying replay-deterministic.
 */
import { z } from "zod";
import type { Store } from "../db/index.ts";
import type { NewEvent } from "../events/types.ts";
import { type Candidate, Candidate as CandidateSchema } from "./candidates.ts";
import { entityId } from "./id.ts";

/** Input to `propose.apply`: the approved, id-stamped candidates to persist. */
export const ProposeApplyInput = z.object({
  candidates: z.array(CandidateSchema).min(1),
});
/** Accepted at the call site (candidate defaults applied by `parse`). */
export type ProposeApplyInput = z.input<typeof ProposeApplyInput>;

/** Per-candidate apply result: `applied` (event appended) or `skipped` (existing). */
export interface AppliedCandidate {
  candidateId: string;
  kind: Candidate["kind"];
  /** Target entity id the event carries / upserted. */
  entityId: string;
  status: "applied" | "skipped";
}

export interface ProposeApplyOutput {
  results: AppliedCandidate[];
  applied: number;
  skipped: number;
}

/** True when an entity with this id already exists in the relevant projection. */
function entityExists(store: Store, candidate: Candidate, id: string): boolean {
  const sqlite = store.connection.sqlite;
  switch (candidate.kind) {
    case "task":
      return sqlite.query("SELECT 1 FROM tasks WHERE id = ?").get(id) !== null;
    case "decision":
      return sqlite.query("SELECT 1 FROM decisions WHERE id = ?").get(id) !== null;
    case "reply_draft":
      // Reply drafts have no projection row of their own; their identity lives in
      // the `links` provenance graph (reply_draft → source, relation replies_to).
      return (
        sqlite
          .query("SELECT 1 FROM links WHERE from_kind = 'reply_draft' AND from_id = ?")
          .get(id) !== null
      );
    case "triage":
      // Triage is idempotent on (inboxId, state): re-applying the same target
      // state is a no-op, but moving to a different state must still apply.
      return (
        sqlite
          .query("SELECT 1 FROM inbox WHERE id = ? AND state = ?")
          .get(id, candidate.state) !== null
      );
  }
}

/** Build the domain event a candidate maps to, targeting the given entity id. */
function candidateToEvent(candidate: Candidate, id: string): NewEvent {
  switch (candidate.kind) {
    case "task":
      return {
        type: "TaskProposed",
        taskId: id,
        title: candidate.title,
        sourceExternalIds: candidate.sourceExternalIds,
      };
    case "decision":
      return {
        type: "DecisionRecorded",
        decisionId: id,
        title: candidate.title,
        rationale: candidate.rationale,
        sourceExternalIds: candidate.sourceExternalIds,
      };
    case "reply_draft":
      return {
        type: "ReplyDraftProposed",
        draftId: id,
        replyToExternalId: candidate.replyToExternalId,
        body: candidate.body,
      };
    case "triage":
      return {
        type: "InboxItemTriaged",
        inboxId: id,
        sourceExternalId: candidate.sourceExternalId,
        state: candidate.state,
      };
  }
}

/**
 * Apply approved candidates, appending one event per *new* candidate. Existing
 * entities (matched by content-derived id) are skipped, making re-application a
 * no-op (idempotent). The host must have obtained human approval before calling.
 */
export function proposeApply(
  store: Store,
  input: ProposeApplyInput,
  now: Date = new Date(),
): ProposeApplyOutput {
  const { candidates } = ProposeApplyInput.parse(input);
  const results: AppliedCandidate[] = [];

  for (const candidate of candidates) {
    const id = entityId(candidate);
    if (entityExists(store, candidate, id)) {
      results.push({ candidateId: candidate.candidateId, kind: candidate.kind, entityId: id, status: "skipped" });
      continue;
    }
    store.record(candidateToEvent(candidate, id), now);
    results.push({ candidateId: candidate.candidateId, kind: candidate.kind, entityId: id, status: "applied" });
  }

  const applied = results.filter((r) => r.status === "applied").length;
  return { results, applied, skipped: results.length - applied };
}
