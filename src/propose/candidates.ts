/**
 * Candidate proposal schemas for the `propose.*` HITL write tools
 * (ADR-0004 / docs/design/mcp-surface.md).
 *
 * `propose.generate` packages content the host LLM has already produced into a
 * structured set of candidates (assigning a stable `candidateId` + provenance to
 * each). It does NOT run any model in-process: the heavy reasoning is delegated
 * to the host (ADR-0006 ML delegation), and this layer only validates + frames
 * the result. `propose.apply` then turns approved candidates into domain events.
 *
 * A candidate is a discriminated union over `kind`, each kind mapping 1:1 to a
 * domain event the apply step will append:
 *   - `task`        → `TaskProposed`
 *   - `decision`    → `DecisionRecorded`
 *   - `reply_draft` → `ReplyDraftProposed`
 *   - `triage`      → `InboxItemTriaged`
 *
 * Modes constrain which candidate kinds a generate call may emit, matching the
 * assistant skills that drive each mode (docs/skills/):
 *   - `reply_draft`      → reply_draft (reply-draft skill)
 *   - `source_extract`   → task / decision / reply_draft (source-extract skill)
 *   - `meeting_followup` → task / decision (meeting-followup skill)
 *   - `inbox_triage`     → task / decision / triage (inbox-triage skill)
 *
 * Nothing here persists: candidates are inert until a human approves a subset
 * and the host calls `propose.apply` (no auto-apply path, ADR-0004 / FR-PRO-2).
 */
import { z } from "zod";

/** Generate modes (mirrors the assistant skills that emit candidates). */
export const PROPOSE_MODES = [
  "reply_draft",
  "source_extract",
  "meeting_followup",
  "inbox_triage",
] as const;
export const ProposeMode = z.enum(PROPOSE_MODES);
export type ProposeMode = z.infer<typeof ProposeMode>;

/** Triage states an `inbox_triage` candidate may move an item into (no `open`). */
export const TRIAGE_STATES = ["snoozed", "done", "dismissed"] as const;
export const TriageState = z.enum(TRIAGE_STATES);
export type TriageState = z.infer<typeof TriageState>;

/** Candidate kinds, each mapping 1:1 to the domain event apply will append. */
export const CANDIDATE_KINDS = ["task", "decision", "reply_draft", "triage"] as const;
export type CandidateKind = (typeof CANDIDATE_KINDS)[number];

/**
 * A `task` candidate (→ `TaskProposed`). The host LLM supplies `title`;
 * `sourceExternalIds` carry provenance back to the source(s) it derives from.
 */
const TaskCandidate = z.object({
  kind: z.literal("task"),
  title: z.string().min(1),
  sourceExternalIds: z.array(z.string().min(1)).default([]),
});

/** A `decision` candidate (→ `DecisionRecorded`). */
const DecisionCandidate = z.object({
  kind: z.literal("decision"),
  title: z.string().min(1),
  rationale: z.string().default(""),
  sourceExternalIds: z.array(z.string().min(1)).default([]),
});

/** A `reply_draft` candidate (→ `ReplyDraftProposed`); user sends manually. */
const ReplyDraftCandidate = z.object({
  kind: z.literal("reply_draft"),
  /** The source being replied to (provenance / `replies_to` link). */
  replyToExternalId: z.string().min(1),
  body: z.string(),
});

/** A `triage` candidate (→ `InboxItemTriaged`) moving an item to a new state. */
const TriageCandidate = z.object({
  kind: z.literal("triage"),
  inboxId: z.string().min(1),
  sourceExternalId: z.string().min(1),
  state: TriageState,
});

/**
 * A candidate as supplied to `propose.generate` (no id yet — generate assigns a
 * stable `candidateId` so the host can reference exactly which ones to apply).
 */
export const CandidateInput = z.discriminatedUnion("kind", [
  TaskCandidate,
  DecisionCandidate,
  ReplyDraftCandidate,
  TriageCandidate,
]);
export type CandidateInput = z.infer<typeof CandidateInput>;

/** A candidate after generate has assigned it a stable `candidateId`. */
export const Candidate = z.discriminatedUnion("kind", [
  TaskCandidate.extend({ candidateId: z.string().min(1) }),
  DecisionCandidate.extend({ candidateId: z.string().min(1) }),
  ReplyDraftCandidate.extend({ candidateId: z.string().min(1) }),
  TriageCandidate.extend({ candidateId: z.string().min(1) }),
]);
export type Candidate = z.infer<typeof Candidate>;

/** Candidate kinds each mode is allowed to emit (HITL surface = skill flows). */
export const MODE_ALLOWED_KINDS: Record<ProposeMode, readonly CandidateKind[]> = {
  reply_draft: ["reply_draft"],
  source_extract: ["task", "decision", "reply_draft"],
  meeting_followup: ["task", "decision"],
  inbox_triage: ["task", "decision", "triage"],
};
