/**
 * Domain event types (Zod discriminated union).
 *
 * The append-only event store is the single source of truth (ADR-0002).
 * Events are immutable and versioned: every event carries `type`,
 * `schemaVersion`, and an envelope of identity/time fields. Projections
 * (`sources` / `tasks` / `decisions` / `inbox` / `proposals` / `commitments` /
 * `links`) are folded from these by reducers and are fully rebuildable via
 * replay.
 *
 * Versioning: each event keeps its own `schemaVersion` (currently `1`).
 * Breaking payload changes bump the per-type version and are upcast in the
 * reducer layer; readers never query raw events directly (ADR-0002).
 */
import { z } from "zod";

/** Current schema version for every event type defined here. */
export const EVENT_SCHEMA_VERSION = 1 as const;

/** ISO 8601 timestamp string. */
const IsoDateTime = z.iso.datetime({ offset: true });

/**
 * Envelope shared by all events. `id` and `recordedAt` are assigned by the
 * append path; `schemaVersion` defaults to the current version on construct.
 */
const Envelope = {
  /** Monotonic event id (assigned by the store on append; ULID/string). */
  id: z.string().min(1),
  /** When the event was appended to the store (store clock). */
  recordedAt: IsoDateTime,
  /** Per-event schema version for upcasting (ADR-0002). */
  schemaVersion: z.literal(EVENT_SCHEMA_VERSION).default(EVENT_SCHEMA_VERSION),
} as const;

/** A new source body was observed by a connector (read-only ingest, ADR-0007). */
export const SourceObserved = z.object({
  type: z.literal("SourceObserved"),
  ...Envelope,
  /** Cross-source-unique id assigned by the connector (ADR-0007). */
  externalId: z.string().min(1),
  /** Projection `source_type` (e.g. "github_issue", "slack_message"). */
  sourceType: z.string().min(1),
  /** Extracted body text held locally (ADR-0003). */
  body: z.string(),
  /** When the source was observed at its origin (ISO 8601). */
  observedAt: IsoDateTime,
  /** Content fingerprint for delta detection (FR-ING-3). */
  fingerprint: z.string().min(1),
  /** Connector-supplied metadata. */
  meta: z.record(z.string(), z.unknown()).default({}),
});

/** An existing source's body changed (detected via fingerprint/cursor). */
export const SourceBodyUpdated = z.object({
  type: z.literal("SourceBodyUpdated"),
  ...Envelope,
  externalId: z.string().min(1),
  body: z.string(),
  observedAt: IsoDateTime,
  fingerprint: z.string().min(1),
  meta: z.record(z.string(), z.unknown()).default({}),
});

/** A connector sync run finished; carries the cursor to resume next time. */
export const ConnectorSyncCompleted = z.object({
  type: z.literal("ConnectorSyncCompleted"),
  ...Envelope,
  connector: z.string().min(1),
  /** Opaque resume cursor (delta APIs); `null` when fingerprint-based. */
  cursor: z.string().nullable().default(null),
  /** Number of source records observed/updated in this run. */
  count: z.number().int().nonnegative().default(0),
});

/** A task candidate was proposed (HITL — not yet applied, ADR-0004). */
export const TaskProposed = z.object({
  type: z.literal("TaskProposed"),
  ...Envelope,
  /** Stable id for the task this proposal targets. */
  taskId: z.string().min(1),
  title: z.string().min(1),
  /** Source(s) this proposal derives from (provenance, links projection). */
  sourceExternalIds: z.array(z.string().min(1)).default([]),
});

/** A proposed task was approved & applied by a human (HITL, ADR-0004). */
export const TaskApplied = z.object({
  type: z.literal("TaskApplied"),
  ...Envelope,
  taskId: z.string().min(1),
  /** Lifecycle state after application. */
  state: z.enum(["open", "in_progress", "completed", "dropped"]).default("open"),
});

/** A decision was recorded (provenance-tracked, ADR-0002). */
export const DecisionRecorded = z.object({
  type: z.literal("DecisionRecorded"),
  ...Envelope,
  decisionId: z.string().min(1),
  title: z.string().min(1),
  rationale: z.string().default(""),
  sourceExternalIds: z.array(z.string().min(1)).default([]),
});

/** A reply draft was proposed for a source (HITL — user sends manually). */
export const ReplyDraftProposed = z.object({
  type: z.literal("ReplyDraftProposed"),
  ...Envelope,
  draftId: z.string().min(1),
  /** Source being replied to. */
  replyToExternalId: z.string().min(1),
  body: z.string(),
});

/** An inbox item was triaged into a state (read-side workflow). */
export const InboxItemTriaged = z.object({
  type: z.literal("InboxItemTriaged"),
  ...Envelope,
  inboxId: z.string().min(1),
  /** Source the inbox item references. */
  sourceExternalId: z.string().min(1),
  state: z.enum(["open", "snoozed", "done", "dismissed"]).default("open"),
});

/**
 * A HITL proposal candidate was generated (Issue #89). Records the candidate in
 * the `proposals` lifecycle ledger as `pending` so it can be listed
 * (`propose.list`) and rejected (`propose.reject`). Persisting the *candidate*
 * (not the domain entity) keeps `propose.generate`'s "no domain entity write"
 * contract while giving the approve/reject HITL loop a durable surface
 * (ADR-0004). The target entity id is content-derived (src/propose/id.ts), so
 * when `propose.apply` later appends the entity event the ledger flips the
 * matching proposal to `applied` by `entity_id`.
 */
export const ProposalGenerated = z.object({
  type: z.literal("ProposalGenerated"),
  ...Envelope,
  /** Content-derived candidate id (stable across regenerate). */
  candidateId: z.string().min(1),
  /** Generate mode the candidate came from. */
  mode: z.string().min(1),
  /** Candidate kind (task / decision / reply_draft / triage). */
  kind: z.string().min(1),
  /** Deterministic target entity id the candidate applies to. */
  entityId: z.string().min(1),
  /** Short human-readable summary (title / draft preview) for listings. */
  summary: z.string().default(""),
  /** Provenance source ids the candidate derives from (best-effort). */
  sourceExternalIds: z.array(z.string().min(1)).default([]),
});

/** A pending proposal candidate was rejected by a human (HITL, ADR-0004). */
export const ProposalRejected = z.object({
  type: z.literal("ProposalRejected"),
  ...Envelope,
  candidateId: z.string().min(1),
  /** Why the candidate was rejected (recorded for the ledger). */
  reason: z.string().default(""),
});

/**
 * A human/agent created a manual provenance link between two entities (HITL,
 * ADR-0004 / ADR-0018 追補). Unlike the reducer-derived edges (`derived_from` /
 * `replies_to` / `references`), a manual link carries its own stable `linkId`
 * (content-derived from the endpoints) so it can be removed by id and replayed
 * deterministically. The relation label is always `manual_link`.
 */
export const LinkAdded = z.object({
  type: z.literal("LinkAdded"),
  ...Envelope,
  /** Stable, content-derived id for this manual link (endpoints → id). */
  linkId: z.string().min(1),
  fromKind: z.string().min(1),
  fromId: z.string().min(1),
  toKind: z.string().min(1),
  toId: z.string().min(1),
});

/** A manual provenance link was removed by id (HITL, audit-able via the log). */
export const LinkRemoved = z.object({
  type: z.literal("LinkRemoved"),
  ...Envelope,
  /** Id of the manual link to remove ({@link LinkAdded}.linkId). */
  linkId: z.string().min(1),
});

/** Direction of a commitment relative to the operator (ADR-0021). */
export const COMMITMENT_DIRECTIONS = ["owed_by_me", "owed_to_me"] as const;
export const CommitmentDirection = z.enum(COMMITMENT_DIRECTIONS);
export type CommitmentDirection = z.infer<typeof CommitmentDirection>;

/**
 * A commitment ("約束/コミットメント") was opened (ADR-0021). The confirmed
 * candidate (extracted via the propose pipeline, ADR-0006) enters the
 * `commitments` ledger in the `open` state. `direction` records who owes whom
 * (owed-by-me / owed-to-me); `dueDate` and `person` are optional context; the
 * provenance `sourceExternalIds` link back to the source(s) it was extracted
 * from. The state machine (open → resolved/dismissed, reopen → open) is driven
 * by the `Commitment*` events below (HITL, ADR-0004).
 */
export const CommitmentOpened = z.object({
  type: z.literal("CommitmentOpened"),
  ...Envelope,
  /** Content-derived commitment id (stable across re-extraction). */
  commitmentId: z.string().min(1),
  /** Short human-readable statement of the commitment ("X までに Y する"). */
  title: z.string().min(1),
  /** Who owes whom (owed-by-me / owed-to-me). */
  direction: CommitmentDirection,
  /** Optional due date (ISO 8601), when the commitment carries one. */
  dueDate: IsoDateTime.nullable().default(null),
  /** Optional related person (free-form / person id). */
  person: z.string().nullable().default(null),
  /** Source(s) the commitment was extracted from (provenance → `links`). */
  sourceExternalIds: z.array(z.string().min(1)).default([]),
});

/** An open commitment was resolved (fulfilled) by a human (HITL, ADR-0004). */
export const CommitmentResolved = z.object({
  type: z.literal("CommitmentResolved"),
  ...Envelope,
  commitmentId: z.string().min(1),
});

/** An open commitment was dismissed (e.g. a false-positive extraction; HITL). */
export const CommitmentDismissed = z.object({
  type: z.literal("CommitmentDismissed"),
  ...Envelope,
  commitmentId: z.string().min(1),
});

/** A resolved/dismissed commitment was reopened back to `open` (HITL). */
export const CommitmentReopened = z.object({
  type: z.literal("CommitmentReopened"),
  ...Envelope,
  commitmentId: z.string().min(1),
});

/** Discriminated union of all domain events (ADR-0002). */
export const DomainEvent = z.discriminatedUnion("type", [
  SourceObserved,
  SourceBodyUpdated,
  ConnectorSyncCompleted,
  TaskProposed,
  TaskApplied,
  DecisionRecorded,
  ReplyDraftProposed,
  InboxItemTriaged,
  ProposalGenerated,
  ProposalRejected,
  LinkAdded,
  LinkRemoved,
  CommitmentOpened,
  CommitmentResolved,
  CommitmentDismissed,
  CommitmentReopened,
]);
export type DomainEvent = z.infer<typeof DomainEvent>;

/** Literal union of every event `type`. */
export const EVENT_TYPES = [
  "SourceObserved",
  "SourceBodyUpdated",
  "ConnectorSyncCompleted",
  "TaskProposed",
  "TaskApplied",
  "DecisionRecorded",
  "ReplyDraftProposed",
  "InboxItemTriaged",
  "ProposalGenerated",
  "ProposalRejected",
  "LinkAdded",
  "LinkRemoved",
  "CommitmentOpened",
  "CommitmentResolved",
  "CommitmentDismissed",
  "CommitmentReopened",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/**
 * Input accepted by the append path: an event without the store-assigned
 * envelope fields (`id`, `recordedAt`). `schemaVersion` is optional (defaults).
 */
export type NewEvent =
  | Omit<z.input<typeof SourceObserved>, "id" | "recordedAt">
  | Omit<z.input<typeof SourceBodyUpdated>, "id" | "recordedAt">
  | Omit<z.input<typeof ConnectorSyncCompleted>, "id" | "recordedAt">
  | Omit<z.input<typeof TaskProposed>, "id" | "recordedAt">
  | Omit<z.input<typeof TaskApplied>, "id" | "recordedAt">
  | Omit<z.input<typeof DecisionRecorded>, "id" | "recordedAt">
  | Omit<z.input<typeof ReplyDraftProposed>, "id" | "recordedAt">
  | Omit<z.input<typeof InboxItemTriaged>, "id" | "recordedAt">
  | Omit<z.input<typeof ProposalGenerated>, "id" | "recordedAt">
  | Omit<z.input<typeof ProposalRejected>, "id" | "recordedAt">
  | Omit<z.input<typeof LinkAdded>, "id" | "recordedAt">
  | Omit<z.input<typeof LinkRemoved>, "id" | "recordedAt">
  | Omit<z.input<typeof CommitmentOpened>, "id" | "recordedAt">
  | Omit<z.input<typeof CommitmentResolved>, "id" | "recordedAt">
  | Omit<z.input<typeof CommitmentDismissed>, "id" | "recordedAt">
  | Omit<z.input<typeof CommitmentReopened>, "id" | "recordedAt">;
