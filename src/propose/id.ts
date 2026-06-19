/**
 * Deterministic, content-derived ids for proposal candidates and the entities
 * they apply to.
 *
 * Idempotence (FR-PRO-2 / the apply contract) hinges on these being a pure
 * function of the candidate content: the same candidate always yields the same
 * `candidateId` and the same target entity id (`taskId` / `decisionId` /
 * `draftId` / `inboxId`), so re-running generate->apply upserts the same
 * projection rows instead of creating duplicates. No randomness, no clock.
 *
 * The hash is FNV-1a (32-bit) rendered as 8 lowercase hex chars — small, stable,
 * dependency-free, and sufficient for collision-resistance across a single
 * user's local candidate set (not a security primitive). A short kind prefix
 * keeps ids self-describing in the projections. Fields are joined with a unit
 * separator (U+001F) that cannot occur in the content, so distinct field
 * boundaries never collide.
 */
import type { Candidate, CandidateInput, ProposeMode } from "./candidates.ts";

/** Field separator for fingerprints (unit separator; never appears in content). */
const SEP = "\x1f";

/** FNV-1a 32-bit hash of a string -> 8 lowercase hex chars. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts (avoids float precision loss).
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Stable string capturing a candidate's identity-relevant content. */
function candidateFingerprint(candidate: CandidateInput): string {
  switch (candidate.kind) {
    case "task":
      return ["task", candidate.title, [...candidate.sourceExternalIds].sort().join(",")].join(SEP);
    case "decision":
      return ["decision", candidate.title, [...candidate.sourceExternalIds].sort().join(",")].join(
        SEP,
      );
    case "reply_draft":
      return ["reply_draft", candidate.replyToExternalId, candidate.body].join(SEP);
    case "triage":
      return ["triage", candidate.inboxId, candidate.state].join(SEP);
  }
}

/** Content-derived candidate id, stable across generate calls for same content. */
export function candidateId(mode: ProposeMode, candidate: CandidateInput): string {
  return `cand_${fnv1a([mode, candidateFingerprint(candidate)].join(SEP))}`;
}

/**
 * Content-derived inbox item id for the `inbox.add` write tool (Issue #88).
 * Keyed on the source the item captures, so capturing the same source twice
 * upserts the same inbox row (idempotent) rather than creating a duplicate item.
 * The `inbox_` prefix keeps the id self-describing in the projection.
 */
export function inboxId(sourceExternalId: string): string {
  return `inbox_${fnv1a(["inbox", sourceExternalId].join(SEP))}`;
}

/**
 * Deterministic target entity id for a candidate (the `taskId` / `decisionId` /
 * `draftId` / `inboxId` the applied event carries). Derived from content so
 * apply upserts the same projection row on re-application.
 */
export function entityId(candidate: Candidate): string {
  const fp = fnv1a(candidateFingerprint(candidate));
  switch (candidate.kind) {
    case "task":
      return `task_${fp}`;
    case "decision":
      return `dec_${fp}`;
    case "reply_draft":
      return `draft_${fp}`;
    case "triage":
      // Triage targets an existing inbox item; its id is the entity id.
      return candidate.inboxId;
  }
}
