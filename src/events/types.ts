/**
 * Domain event types (Zod discriminated union).
 *
 * The append-only event store is the single source of truth (ADR-0002).
 * Events are immutable and versioned: every event carries `type`,
 * `schemaVersion`, and an envelope of identity/time fields. Projections
 * (`sources` / `tasks` / `decisions` / `inbox` / `proposals` / `commitments` /
 * `persons` / `links`) are folded from these by reducers and are fully
 * rebuildable via replay.
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

/**
 * A source was forgotten — purged locally (ADR-0026). Body-less audit record:
 * the content is redacted from the historical SourceObserved/SourceBodyUpdated
 * payloads and this event's reducer DELETEs the projection row (so a
 * `projections rebuild` keeps it absent — replay-stable). Keeps an audit trail
 * of *that* a source was forgotten without retaining its content.
 */
export const SourceForgotten = z.object({
  type: z.literal("SourceForgotten"),
  ...Envelope,
  externalId: z.string().min(1),
  /** Optional human reason (audit only). */
  reason: z.string().optional(),
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

/** Terminal status of a sync run (ADR-0033). */
export const SYNC_RUN_STATUSES = ["ok", "partial", "error"] as const;
export const SyncRunStatus = z.enum(SYNC_RUN_STATUSES);
export type SyncRunStatus = z.infer<typeof SyncRunStatus>;

/**
 * A connector sync run started (ADR-0033). Emitted by the shared `syncConnector`
 * service before the ingest pass begins, so every entry point (CLI single sync /
 * `suasor sync` bulk / `connector.sync` MCP) records run history identically
 * (ADR-0007 single code path). `runId` is content-derived (`<connector>:<startedAt>`)
 * so the matching `SyncRunEnded` can pair to it and replay stays deterministic.
 *
 * Distinct from `ConnectorSyncCompleted` (which carries only the resume cursor and
 * is appended only on a *successful* terminal pass): a run that throws mid-way
 * still gets a `SyncRunEnded(status=error)`, so failed runs are visible in the
 * freshness view — something the cursor event alone could never surface.
 */
export const SyncRunStarted = z.object({
  type: z.literal("SyncRunStarted"),
  ...Envelope,
  /** Connector that started syncing (e.g. "github"). */
  connector: z.string().min(1),
  /** Content-derived run id (`<connector>:<startedAt>`); pairs with SyncRunEnded. */
  runId: z.string().min(1),
  /** When the run started (ISO 8601; the service clock). */
  startedAt: IsoDateTime,
});

/**
 * A connector sync run finished — success, partial, or error (ADR-0033). Carries
 * the per-run counts, duration, and terminal status; folded into the `sync_runs`
 * projection as the connector's latest run so `suasor sync status` can show the
 * last sync time / counts / outcome. `error` holds the failure message when
 * `status = "error"` (a connector threw); omitted otherwise.
 */
export const SyncRunEnded = z.object({
  type: z.literal("SyncRunEnded"),
  ...Envelope,
  connector: z.string().min(1),
  /** Same content-derived id as the matching {@link SyncRunStarted}. */
  runId: z.string().min(1),
  /** Terminal status: ok (clean) / partial (sub-unit failed) / error (threw). */
  status: SyncRunStatus,
  /** New sources observed this run. */
  observed: z.number().int().nonnegative().default(0),
  /** Existing sources whose body changed this run. */
  updated: z.number().int().nonnegative().default(0),
  /** Existing sources skipped (fingerprint unchanged) this run. */
  unchanged: z.number().int().nonnegative().default(0),
  /** Wall-clock duration of the run in milliseconds. */
  durationMs: z.number().int().nonnegative().default(0),
  /** Failure message when status = "error"; omitted on ok / partial. */
  error: z.string().optional(),
});

/** Task priority levels (ADR-0028). `null` = unprioritised. */
export const TASK_PRIORITIES = ["low", "normal", "high"] as const;
export const TaskPriority = z.enum(TASK_PRIORITIES);
export type TaskPriority = z.infer<typeof TaskPriority>;

/**
 * A task candidate was proposed (HITL — not yet applied, ADR-0004).
 *
 * `dueDate` / `priority` are scheduling fields (ADR-0028, mirroring commitment's
 * `dueDate`): both default to `null`, so an *old* event without them parses to
 * `null` (backward-compatible replay — ADR-0002, no schemaVersion bump since the
 * change is purely additive). `overdue` is NOT stored — it is derived at read
 * time from `dueDate < now AND state ∈ {open,in_progress}` (current-time state
 * must not be folded into a replay-stable projection).
 */
export const TaskProposed = z.object({
  type: z.literal("TaskProposed"),
  ...Envelope,
  /** Stable id for the task this proposal targets. */
  taskId: z.string().min(1),
  title: z.string().min(1),
  /** Optional due date (ISO 8601), when the task carries one (ADR-0028). */
  dueDate: IsoDateTime.nullable().default(null),
  /** Optional priority (low / normal / high); null when unprioritised (ADR-0028). */
  priority: TaskPriority.nullable().default(null),
  /** Source(s) this proposal derives from (provenance, links projection). */
  sourceExternalIds: z.array(z.string().min(1)).default([]),
});

/**
 * A proposed task was approved & applied by a human (HITL, ADR-0004).
 *
 * Carries the optional scheduling fields (ADR-0028) so applying a task can also
 * (re)set its `dueDate` / `priority`. Both default to `null` for backward-
 * compatible replay of pre-ADR-0028 events; a `null` value on apply leaves the
 * proposed value untouched (the reducer only overwrites a non-null update).
 */
export const TaskApplied = z.object({
  type: z.literal("TaskApplied"),
  ...Envelope,
  taskId: z.string().min(1),
  /** Lifecycle state after application. */
  state: z.enum(["open", "in_progress", "completed", "dropped"]).default("open"),
  /** Optional due date (ISO 8601) to (re)set on apply; null leaves it untouched. */
  dueDate: IsoDateTime.nullable().default(null),
  /** Optional priority to (re)set on apply; null leaves it untouched (ADR-0028). */
  priority: TaskPriority.nullable().default(null),
});

/** External task-home destinations a task can be published to (ADR-0036). */
export const TaskDestination = z.enum(["github", "jira", "slack"]);
export type TaskDestination = z.infer<typeof TaskDestination>;

/**
 * A task was published (起票) to its single external home (ADR-0036, egress).
 *
 * Body-less audit event (mirrors {@link DraftExported}): it records *that* the
 * task was created in an external tool and *where* (the cross-source `externalId`
 * is the identity link that lets later syncs recognise "this external item is my
 * task" — loop avoidance, ADR-0036 §8). It carries no task body. The reducer
 * folds the link onto the `tasks` projection (published_*) and is idempotent on
 * `externalId` (re-publish of the same task is a no-op, matching the
 * deterministic `taskId` idempotency key).
 */
export const TaskPublished = z.object({
  type: z.literal("TaskPublished"),
  ...Envelope,
  taskId: z.string().min(1),
  /** Which external home the task was published to. */
  destination: TaskDestination,
  /** Cross-source-unique id of the created external item (identity link). */
  externalId: z.string().min(1),
  /** When the task was published (ISO 8601). */
  publishedAt: IsoDateTime,
});

/**
 * A state operation (complete / reopen / comment) was issued to a published
 * task's external home (ADR-0036, single-pane write-back). Body-less audit
 * event: the comment body (when `action === "comment"`) is sent to the tool but
 * NOT folded here (content-minimization, ADR-0003). Projection no-op — the
 * authoritative state lives in the tool and is reflected back via read-back
 * (ADR-0036 §6), so this event is audit-only (same as {@link DraftExported}).
 */
export const TaskActionIssued = z.object({
  type: z.literal("TaskActionIssued"),
  ...Envelope,
  taskId: z.string().min(1),
  /** External item the action targeted. */
  externalId: z.string().min(1),
  /** The state operation issued to the external home. */
  action: z.enum(["complete", "reopen", "drop", "comment"]),
  /** When the action was issued (ISO 8601). */
  issuedAt: IsoDateTime,
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

/**
 * A draft was exported to a local file (ADR-0025). Body-less audit event: the
 * content lives only in the export file (content-minimization) — this records
 * that an export happened, for provenance. No projection (reducer no-op, like
 * ConnectorSyncCompleted); replay does not re-write the file.
 */
export const DraftExported = z.object({
  type: z.literal("DraftExported"),
  ...Envelope,
  /** Absolute path the draft was written to (inside the export sandbox). */
  path: z.string().min(1),
  /** Export format (md/txt direct; docx/pptx/xlsx via composition sidecar, #138). */
  format: z.enum(["md", "txt", "docx", "pptx", "xlsx"]),
  /** Source the draft derives from, when applicable (provenance). */
  sourceExternalId: z.string().min(1).optional(),
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
 * Human feedback on a pending proposal candidate (HITL, ADR-0004 / Issue #279).
 *
 * The third option beyond apply/reject: instead of accepting or discarding a
 * candidate outright, the human records a `reason` ("修正して再生成") so the next
 * `propose.generate` can use it as a hint. Unlike `ProposalRejected`, this does
 * NOT change the candidate's lifecycle state — it stays `pending` (still
 * appliable/rejectable); it only records the latest feedback `reason` on the
 * ledger row. Acts only on a still-`pending` candidate (an applied/rejected one
 * is decided); the write tool reports an invalid/missing target.
 */
export const ProposalFeedback = z.object({
  type: z.literal("ProposalFeedback"),
  ...Envelope,
  candidateId: z.string().min(1),
  /** Feedback note for the next regeneration (recorded on the ledger row). */
  reason: z.string().min(1),
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

/**
 * A connector author handle was observed and bound to a person (ADR-0022).
 *
 * Emitted by the sync service the first time it sees a `(connector, handle)`
 * pair on an ingested source. Initial policy is **1 handle = 1 person** (no
 * automatic fuzzy de-duplication): `personId` is content-derived from the
 * `(connector, handle)` pair, so re-observing the same handle is idempotent and
 * never resurrects a person an operator has since merged away. Operators
 * collapse duplicates explicitly via `PersonsMerged` / `PersonSplit` (HITL).
 */
export const PersonIdentityObserved = z.object({
  type: z.literal("PersonIdentityObserved"),
  ...Envelope,
  /** Person this identity initially binds to (content-derived from the handle). */
  personId: z.string().min(1),
  /** Connector that surfaced the handle (e.g. "github", "slack"). */
  connector: z.string().min(1),
  /** Author handle as the connector reports it (login / `Uxxxx` / address). */
  handle: z.string().min(1),
  /** Optional human-readable display name for the handle, when known. */
  displayName: z.string().optional(),
});

/**
 * Two persons were merged into one by an operator (ADR-0022, HITL — ADR-0004).
 *
 * Every identity of `sourcePersonId` is reassigned to `targetPersonId`; the
 * source person is left with no identities. Recorded as an event so the merge
 * is auditable and reversible — a later `PersonSplit` moves an identity back
 * out (no fuzzy auto-merge ever happens; only explicit operator actions).
 */
export const PersonsMerged = z.object({
  type: z.literal("PersonsMerged"),
  ...Envelope,
  /** Person that absorbs the other's identities (survives). */
  targetPersonId: z.string().min(1),
  /** Person whose identities move to the target (emptied). */
  sourcePersonId: z.string().min(1),
});

/**
 * One identity was split off an existing person into another person (ADR-0022,
 * HITL — ADR-0004). The inverse of a merge: corrects an over-merge by moving a
 * single `(connector, handle)` identity to `newPersonId` (created on demand).
 */
export const PersonSplit = z.object({
  type: z.literal("PersonSplit"),
  ...Envelope,
  /** Connector of the identity being moved out. */
  connector: z.string().min(1),
  /** Handle of the identity being moved out. */
  handle: z.string().min(1),
  /** Person the identity is moved to (created if it does not yet exist). */
  newPersonId: z.string().min(1),
});

/**
 * Slack channel kinds for the `slack_channels` projection (ADR-0037 §3). Derived
 * from the conversation id prefix + the `conversations.info` classification:
 * `public` / `private` channels, a group DM (`group`), or a single DM (`dm`).
 */
export const SLACK_CHANNEL_KINDS = ["public", "private", "group", "dm"] as const;
export const SlackChannelKind = z.enum(SLACK_CHANNEL_KINDS);
export type SlackChannelKind = z.infer<typeof SlackChannelKind>;

/**
 * A Slack channel/conversation id was observed and name-resolved at sync time
 * (ADR-0037 §3). Folded into the `slack_channels` projection (last-write-wins)
 * so display layers can join a `C…/G…/D…` id to a human name **without a live
 * fetch** (no-fetch-at-query, ADR-0012). An additive new type on the
 * discriminated union — `schemaVersion` is unchanged (existing payloads are
 * untouched, so ADR-0002 needs no upcast).
 *
 * `displayName` is optional: on a degrade (missing scope / API error, ADR-0037
 * §6) it is emitted empty/absent so the reducer keeps any prior resolved name
 * (last-write-wins with a non-empty guard, mirroring the person display name)
 * and the display layer falls back to the id.
 */
export const SlackChannelObserved = z.object({
  type: z.literal("SlackChannelObserved"),
  ...Envelope,
  /** Slack conversation id (`C…` public/private, `G…` group DM, `D…` single DM). */
  channelId: z.string().min(1),
  /** Team / workspace id this channel belongs to (id-prefix scope, ADR-0014). */
  teamId: z.string().min(1),
  /** Resolved human-readable name; empty/absent when unresolved (degrade, §6). */
  displayName: z.string().optional(),
  /** Channel kind (public / private / group / dm), from id prefix + API. */
  kind: SlackChannelKind,
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
  SourceForgotten,
  ConnectorSyncCompleted,
  SyncRunStarted,
  SyncRunEnded,
  TaskProposed,
  TaskApplied,
  TaskPublished,
  TaskActionIssued,
  DecisionRecorded,
  ReplyDraftProposed,
  DraftExported,
  InboxItemTriaged,
  ProposalGenerated,
  ProposalRejected,
  ProposalFeedback,
  LinkAdded,
  LinkRemoved,
  PersonIdentityObserved,
  PersonsMerged,
  PersonSplit,
  SlackChannelObserved,
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
  "SourceForgotten",
  "ConnectorSyncCompleted",
  "SyncRunStarted",
  "SyncRunEnded",
  "TaskProposed",
  "TaskApplied",
  "TaskPublished",
  "TaskActionIssued",
  "DecisionRecorded",
  "ReplyDraftProposed",
  "DraftExported",
  "InboxItemTriaged",
  "ProposalGenerated",
  "ProposalRejected",
  "ProposalFeedback",
  "LinkAdded",
  "LinkRemoved",
  "PersonIdentityObserved",
  "PersonsMerged",
  "PersonSplit",
  "SlackChannelObserved",
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
  | Omit<z.input<typeof SourceForgotten>, "id" | "recordedAt">
  | Omit<z.input<typeof ConnectorSyncCompleted>, "id" | "recordedAt">
  | Omit<z.input<typeof SyncRunStarted>, "id" | "recordedAt">
  | Omit<z.input<typeof SyncRunEnded>, "id" | "recordedAt">
  | Omit<z.input<typeof TaskProposed>, "id" | "recordedAt">
  | Omit<z.input<typeof TaskApplied>, "id" | "recordedAt">
  | Omit<z.input<typeof TaskPublished>, "id" | "recordedAt">
  | Omit<z.input<typeof TaskActionIssued>, "id" | "recordedAt">
  | Omit<z.input<typeof DecisionRecorded>, "id" | "recordedAt">
  | Omit<z.input<typeof ReplyDraftProposed>, "id" | "recordedAt">
  | Omit<z.input<typeof DraftExported>, "id" | "recordedAt">
  | Omit<z.input<typeof InboxItemTriaged>, "id" | "recordedAt">
  | Omit<z.input<typeof ProposalGenerated>, "id" | "recordedAt">
  | Omit<z.input<typeof ProposalRejected>, "id" | "recordedAt">
  | Omit<z.input<typeof ProposalFeedback>, "id" | "recordedAt">
  | Omit<z.input<typeof LinkAdded>, "id" | "recordedAt">
  | Omit<z.input<typeof LinkRemoved>, "id" | "recordedAt">
  | Omit<z.input<typeof PersonIdentityObserved>, "id" | "recordedAt">
  | Omit<z.input<typeof PersonsMerged>, "id" | "recordedAt">
  | Omit<z.input<typeof PersonSplit>, "id" | "recordedAt">
  | Omit<z.input<typeof SlackChannelObserved>, "id" | "recordedAt">
  | Omit<z.input<typeof CommitmentOpened>, "id" | "recordedAt">
  | Omit<z.input<typeof CommitmentResolved>, "id" | "recordedAt">
  | Omit<z.input<typeof CommitmentDismissed>, "id" | "recordedAt">
  | Omit<z.input<typeof CommitmentReopened>, "id" | "recordedAt">;
