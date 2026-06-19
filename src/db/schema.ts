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
