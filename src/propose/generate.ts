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
import {
  type Candidate,
  CandidateInput,
  MODE_ALLOWED_KINDS,
  ProposeMode,
} from "./candidates.ts";
import { candidateId } from "./id.ts";

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
