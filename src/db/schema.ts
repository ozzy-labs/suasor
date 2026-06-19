/**
 * Drizzle schema for projections (read models).
 *
 * Projections are rebuildable from the event store (ADR-0002), so these tables
 * are "drop + rebuild" friendly and carry no in-place migration burden.
 * The append-only `events` table itself is NOT modeled here — it is owned by
 * the raw-SQL append path (src/db/events-table.ts) per ADR-0002.
 *
 * Virtual tables (`sources_fts` FTS5, `embeddings_vec_*` vec0) are likewise not
 * Drizzle-managed; they are created at init in src/db/connection.ts.
 */
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Ingested sources (body held locally, ADR-0003). Keyed by connector externalId. */
export const sources = sqliteTable("sources", {
  externalId: text("external_id").primaryKey(),
  sourceType: text("source_type").notNull(),
  body: text("body").notNull(),
  fingerprint: text("fingerprint").notNull(),
  observedAt: text("observed_at").notNull(),
  /** JSON-encoded connector metadata. */
  meta: text("meta").notNull().default("{}"),
});

/** Task projection (proposed → applied lifecycle, HITL per ADR-0004). */
export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  /** "proposed" until a human applies it; then the applied lifecycle state. */
  state: text("state").notNull().default("proposed"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** Decision projection (provenance-tracked, ADR-0002). */
export const decisions = sqliteTable("decisions", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  rationale: text("rationale").notNull().default(""),
  recordedAt: text("recorded_at").notNull(),
});

/** Inbox projection (triage workflow). */
export const inbox = sqliteTable("inbox", {
  id: text("id").primaryKey(),
  sourceExternalId: text("source_external_id").notNull(),
  state: text("state").notNull().default("open"),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Proposal lifecycle ledger (Issue #89). One row per HITL candidate the host
 * generated, tracking its state through the approve/reject loop:
 *   - `pending`  — generated, awaiting human decision (propose.list shows it)
 *   - `applied`  — a human approved it and propose.apply persisted the entity
 *   - `rejected` — a human rejected it via propose.reject (carries a reason)
 * Folded from `ProposalGenerated` / `ProposalRejected` plus the entity events
 * propose.apply appends (matched back by `entity_id`). Rebuildable (ADR-0002).
 */
export const proposals = sqliteTable("proposals", {
  candidateId: text("candidate_id").primaryKey(),
  mode: text("mode").notNull(),
  kind: text("kind").notNull(),
  /** Deterministic target entity id the candidate applies to. */
  entityId: text("entity_id").notNull(),
  /** Short human-readable summary for listings. */
  summary: text("summary").notNull().default(""),
  /** Lifecycle state: pending / applied / rejected. */
  state: text("state").notNull().default("pending"),
  /** Rejection reason (empty unless state = rejected). */
  reason: text("reason").notNull().default(""),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Commitment ledger (ADR-0021). One row per extracted/confirmed commitment
 * ("約束/コミットメント"), tracking its state through the HITL lifecycle:
 *   - `open`      — confirmed and outstanding (commitment.list shows it)
 *   - `resolved`  — fulfilled (commitment.resolve)
 *   - `dismissed` — a false-positive / no-longer-relevant (commitment.dismiss)
 * `direction` records who owes whom (owed_by_me / owed_to_me); `dueDate` and
 * `person` are optional context. Folded from the `Commitment*` events; matched
 * back to its source(s) via the `links` projection. Rebuildable (ADR-0002).
 */
export const commitments = sqliteTable("commitments", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  /** Who owes whom: "owed_by_me" / "owed_to_me". */
  direction: text("direction").notNull(),
  /** Lifecycle state: open / resolved / dismissed. */
  state: text("state").notNull().default("open"),
  /** Optional due date (ISO 8601); NULL when the commitment has none. */
  dueDate: text("due_date"),
  /** Optional related person (free-form / person id); NULL when unknown. */
  person: text("person"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Relation graph between projection entities (provenance links).
 * e.g. task → source, decision → source, reply_draft → source.
 *
 * Reducer-derived edges (`derived_from` / `replies_to` / `references`) carry a
 * NULL `linkId` and are keyed only by their endpoints. Manual links (`manual_link`,
 * ADR-0018 追補 / Issue #90) carry a stable content-derived `linkId` so they can be
 * removed by id (`link.remove`) and replayed deterministically.
 */
export const links = sqliteTable("links", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** Origin entity kind/id (e.g. "task", <taskId>). */
  fromKind: text("from_kind").notNull(),
  fromId: text("from_id").notNull(),
  /** Target entity kind/id (e.g. "source", <externalId>). */
  toKind: text("to_kind").notNull(),
  toId: text("to_id").notNull(),
  /** Relationship label (e.g. "derived_from", "replies_to", "manual_link"). */
  relation: text("relation").notNull(),
  /** Stable id for a manual link (NULL for reducer-derived edges). */
  linkId: text("link_id"),
});

/**
 * Person projection (ADR-0022). One row per resolved person; a person is the
 * unit connector author handles collapse into. Created on first observation of
 * any of its identities (1 handle = 1 person initially) and surviving merges.
 * `identityCount` mirrors how many `personIdentities` rows point here, so an
 * emptied (fully-merged-away) person can be elided from `person.list`.
 */
export const persons = sqliteTable("persons", {
  id: text("id").primaryKey(),
  /** Best-known display name (latest non-empty observed/merged); may be empty. */
  displayName: text("display_name").notNull().default(""),
  /** Number of identities currently bound to this person. */
  identityCount: integer("identity_count").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * Person identity projection (ADR-0022): the `(connector, handle)` author keys
 * bound to a person. Keyed by `identityKey` = `<connector>:<handle>` so a handle
 * resolves to exactly one person at a time. `personId` is reassigned by
 * `PersonsMerged` / `PersonSplit` (HITL); the handle itself never changes.
 */
export const personIdentities = sqliteTable("person_identities", {
  /** Stable key `<connector>:<handle>` (one identity = one row). */
  identityKey: text("identity_key").primaryKey(),
  /** Person this identity currently resolves to. */
  personId: text("person_id").notNull(),
  connector: text("connector").notNull(),
  handle: text("handle").notNull(),
  displayName: text("display_name").notNull().default(""),
  observedAt: text("observed_at").notNull(),
});
