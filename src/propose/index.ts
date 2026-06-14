/**
 * Propose module: HITL candidate generation + application + direct task creation
 * (ADR-0004 / FR-PRO-1,2 / docs/design/mcp-surface.md).
 *
 * The write-side of the MCP surface beyond `connector.sync`:
 *   - `propose.generate` frames host-produced content into id-stamped candidates
 *     (no persistence, ML stays out-of-process per ADR-0006),
 *   - `propose.apply` persists approved candidates as domain events (idempotent),
 *   - `task.create` is the direct human "add task" path.
 *
 * All three are HITL: there is no auto-apply path (ADR-0004 / FR-PRO-2).
 */
export {
  type AppliedCandidate,
  proposeApply,
  ProposeApplyInput,
  type ProposeApplyOutput,
} from "./apply.ts";
export {
  Candidate,
  CANDIDATE_KINDS,
  CandidateInput,
  type CandidateKind,
  MODE_ALLOWED_KINDS,
  PROPOSE_MODES,
  ProposeMode,
  TRIAGE_STATES,
  type TriageState,
} from "./candidates.ts";
export {
  proposeGenerate,
  ProposeGenerateInput,
  type ProposeGenerateOutput,
} from "./generate.ts";
export { candidateId, entityId } from "./id.ts";
export {
  taskCreate,
  TaskCreateInput,
  type TaskCreateOutput,
} from "./task-create.ts";
