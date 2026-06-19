/**
 * Propose module: HITL candidate generation + application + direct task creation
 * (ADR-0004 / FR-PRO-1,2 / docs/design/mcp-surface.md).
 *
 * The write-side of the MCP surface beyond `connector.sync`:
 *   - `propose.generate` frames host-produced content into id-stamped candidates
 *     (no persistence, ML stays out-of-process per ADR-0006),
 *   - `propose.apply` persists approved candidates as domain events (idempotent),
 *   - `task.create` is the direct human "add task" path,
 *   - `decision.record` is the direct human "log decision" path,
 *   - `inbox.add` / `inbox.triage` are the daily inbox capture + resolution loop,
 *   - `link.add` / `link.remove` are the manual knowledge-graph link CRUD (#90),
 *   - `commitment.resolve` / `.dismiss` / `.reopen` drive the commitment ledger
 *     lifecycle (ADR-0021); extraction rides the `commitment_scan` propose mode,
 *   - `person.merge` / `person.split` resolve connector author identities (#92).
 *
 * All are HITL: there is no auto-apply path (ADR-0004 / FR-PRO-2).
 */
export {
  type AppliedCandidate,
  ProposeApplyInput,
  type ProposeApplyOutput,
  proposeApply,
} from "./apply.ts";
export {
  CANDIDATE_KINDS,
  Candidate,
  CandidateInput,
  type CandidateKind,
  COMMITMENT_DIRECTIONS,
  CommitmentDirection,
  MODE_ALLOWED_KINDS,
  PROPOSE_MODES,
  ProposeMode,
  TRIAGE_STATES,
  type TriageState,
} from "./candidates.ts";
export {
  CommitmentTransitionInput,
  type CommitmentTransitionOutput,
  commitmentDismiss,
  commitmentReopen,
  commitmentResolve,
} from "./commitment.ts";
export {
  DecisionRecordInput,
  type DecisionRecordOutput,
  decisionRecord,
} from "./decision-record.ts";
export {
  ProposeGenerateInput,
  type ProposeGenerateOutput,
  persistProposals,
  proposeGenerate,
} from "./generate.ts";
export { candidateId, entityId, inboxId, manualLinkId } from "./id.ts";
export {
  InboxAddInput,
  type InboxAddOutput,
  inboxAdd,
} from "./inbox-add.ts";
export {
  InboxTriageInput,
  type InboxTriageOutput,
  inboxTriage,
  TRIAGE_ACTIONS,
  TriageAction,
  TriageError,
} from "./inbox-triage.ts";
export {
  LinkAddInput,
  type LinkAddOutput,
  linkAdd,
} from "./link-add.ts";
export {
  LinkRemoveInput,
  type LinkRemoveOutput,
  linkRemove,
} from "./link-remove.ts";
export {
  PersonMergeInput,
  type PersonMergeOutput,
  personMerge,
} from "./person-merge.ts";
export {
  PersonSplitInput,
  type PersonSplitOutput,
  personSplit,
} from "./person-split.ts";
export {
  ProposeRejectInput,
  type ProposeRejectOutput,
  proposeReject,
} from "./reject.ts";
export {
  TaskCreateInput,
  type TaskCreateOutput,
  taskCreate,
} from "./task-create.ts";
