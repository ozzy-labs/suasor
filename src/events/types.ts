/**
 * Domain event types (Zod discriminated union).
 *
 * The append-only event store is the single source of truth (ADR-0002).
 * Events are immutable and versioned: every event carries `type`,
 * `schemaVersion`, and an envelope of identity/time fields. Projections
 * (`sources` / `tasks` / `decisions` / `inbox` / `links`) are folded from
 * these by reducers and are fully rebuildable via replay.
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
  LinkAdded,
  LinkRemoved,
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
  "LinkAdded",
  "LinkRemoved",
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
  | Omit<z.input<typeof LinkAdded>, "id" | "recordedAt">
  | Omit<z.input<typeof LinkRemoved>, "id" | "recordedAt">;
