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
 * Relation graph between projection entities (provenance links).
 * e.g. task → source, decision → source, reply_draft → source.
 */
export const links = sqliteTable("links", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** Origin entity kind/id (e.g. "task", <taskId>). */
  fromKind: text("from_kind").notNull(),
  fromId: text("from_id").notNull(),
  /** Target entity kind/id (e.g. "source", <externalId>). */
  toKind: text("to_kind").notNull(),
  toId: text("to_id").notNull(),
  /** Relationship label (e.g. "derived_from", "replies_to"). */
  relation: text("relation").notNull(),
});
