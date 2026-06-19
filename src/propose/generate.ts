/**
 * `propose.generate` — package host-supplied content into HITL candidates
 * (ADR-0004 / FR-PRO-1 / docs/design/mcp-surface.md).
 *
 * This is a write-category tool only in the HITL sense: it produces *candidates*
 * but persists nothing. The host LLM does the reasoning (read the source, draft
 * the reply, extract the tasks) — ML stays out-of-process (ADR-0006) — and hands
 * the result here. `generate` then:
 *   1. validates the items against the mode's allowed candidate kinds, and
 *   2. assigns each a stable, content-derived `candidateId`.
 *
 * The id is a content hash so the same candidate yields the same id across
 * calls; combined with the deterministic entity ids `propose.apply` derives from
 * the same content, re-running generate→apply converges to the same projection
 * state (idempotence — the apply step's contract, FR-PRO-2 / FR-MNT-1).
 *
 * Returns the candidates inert; nothing is appended until a human approves a
 * subset and the host calls `propose.apply` (no auto-apply path, ADR-0004).
 */
import { z } from "zod";
import type { Store } from "../db/index.ts";
import { type Candidate, CandidateInput, MODE_ALLOWED_KINDS, ProposeMode } from "./candidates.ts";
import { candidateId, entityId } from "./id.ts";

/** Input to `propose.generate`: a mode plus the host-produced candidate items. */
export const ProposeGenerateInput = z.object({
  mode: ProposeMode,
  candidates: z.array(CandidateInput).min(1),
});
/** Accepted at the call site (candidate defaults applied by `parse`). */
export type ProposeGenerateInput = z.input<typeof ProposeGenerateInput>;

/** Output of `propose.generate`: the mode echoed back plus id-stamped candidates. */
export interface ProposeGenerateOutput {
  mode: ProposeMode;
  candidates: Candidate[];
}

/**
 * Validate + frame host-supplied candidates for a mode. Pure (no I/O, no
 * persistence): assigns each candidate a content-derived `candidateId` and
 * returns them for the host to present for approval.
 *
 * @throws {z.ZodError} when the input shape is invalid.
 * @throws {Error} when a candidate's `kind` is not allowed for the given mode.
 */
export function proposeGenerate(input: ProposeGenerateInput): ProposeGenerateOutput {
  const { mode, candidates } = ProposeGenerateInput.parse(input);
  const allowed = MODE_ALLOWED_KINDS[mode];

  const stamped: Candidate[] = candidates.map((candidate) => {
    if (!allowed.includes(candidate.kind)) {
      throw new Error(
        `candidate kind "${candidate.kind}" is not valid for mode "${mode}" ` +
          `(allowed: ${allowed.join(", ")})`,
      );
    }
    return { ...candidate, candidateId: candidateId(mode, candidate) } as Candidate;
  });

  return { mode, candidates: stamped };
}

/** Short, human-readable one-liner for a candidate (used in proposal listings). */
function candidateSummary(candidate: Candidate): string {
  switch (candidate.kind) {
    case "task":
    case "decision":
      return candidate.title;
    case "reply_draft":
      return candidate.body;
    case "triage":
      return `${candidate.inboxId} → ${candidate.state}`;
  }
}

/** Provenance source ids carried by a candidate (best-effort; empty for some kinds). */
function candidateSources(candidate: Candidate): string[] {
  switch (candidate.kind) {
    case "task":
    case "decision":
      return candidate.sourceExternalIds;
    case "reply_draft":
      return [candidate.replyToExternalId];
    case "triage":
      return [candidate.sourceExternalId];
  }
}

/**
 * Persist generated candidates into the `proposals` lifecycle ledger as `pending`
 * (Issue #89) by appending one `ProposalGenerated` event each. This is what gives
 * `propose.list` / `propose.reject` a durable surface; it records the *candidate*
 * (not the domain entity), so `propose.generate`'s "no domain entity write"
 * contract holds. Idempotent: re-generating the same candidate upserts the same
 * ledger row (content-derived `candidateId`) without resurrecting a decided one.
 *
 * Returns the stamped candidates so the host can present them for approval.
 */
export function persistProposals(
  store: Store,
  input: ProposeGenerateInput,
  now: Date = new Date(),
): ProposeGenerateOutput {
  const result = proposeGenerate(input);
  const sqlite = store.connection.sqlite;
  for (const candidate of result.candidates) {
    // Idempotent at the event layer: the candidate id is content-derived, so a
    // ledger row already existing means this exact candidate was generated
    // before — don't append a redundant ProposalGenerated (and never resurrect a
    // decided one). New candidates fall through and are recorded as `pending`.
    const exists = sqlite
      .query("SELECT 1 FROM proposals WHERE candidate_id = ?")
      .get(candidate.candidateId);
    if (exists !== null) continue;
    store.record(
      {
        type: "ProposalGenerated",
        candidateId: candidate.candidateId,
        mode: result.mode,
        kind: candidate.kind,
        entityId: entityId(candidate),
        summary: candidateSummary(candidate),
        sourceExternalIds: candidateSources(candidate),
      },
      now,
    );
  }
  return result;
}
