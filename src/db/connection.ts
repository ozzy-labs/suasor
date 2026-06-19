/**
 * Database connection + schema initialization.
 *
 * Opens a `bun:sqlite` database, loads the `sqlite-vec` extension, and creates
 * the storage substrate:
 * - `events` append-only table (raw SQL, ADR-0002) — see ./events-table.ts
 * - Drizzle-managed projection tables (./schema.ts)
 * - `sources_fts` FTS5 virtual table (trigram tokenizer for JA/EN substring,
 *   ADR-0005 / docs/design/retrieval.md)
 * - `embeddings_vec_default` vec0 virtual table (sqlite-vec; populated only when
 *   an embedding backend is enabled — kept as a cheap substrate, ADR-0005)
 *
 * `init` is idempotent: every DDL uses `IF NOT EXISTS`, so re-running it on an
 * existing database is safe (drop+rebuild of projections is handled separately
 * by the rebuild path).
 */
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { getLoadablePath } from "sqlite-vec";
import { createEventsTable } from "./events-table.ts";
import * as schema from "./schema.ts";

/** Default vec0 table name and embedding dimension (bge-m3 = 1024). */
export const DEFAULT_VEC_TABLE = "embeddings_vec_default";
export const DEFAULT_EMBEDDING_DIM = 1024;

export interface SuasorDb {
  /** Raw bun:sqlite handle (used by the raw-SQL event append path). */
  readonly sqlite: Database;
  /** Drizzle client over the projection schema. */
  readonly orm: ReturnType<typeof drizzle<typeof schema>>;
  /** Close the underlying handle. */
  close(): void;
}

export interface OpenOptions {
  /** `":memory:"` for tests, or a filesystem path. */
  path: string;
  /** Embedding vector dimension for the default vec0 table. */
  embeddingDim?: number;
  /** When false, skip loading sqlite-vec / creating the vec0 table. */
  enableVec?: boolean;
}

/** Load the sqlite-vec extension into a handle (vec0 virtual table support). */
export function loadVecExtension(sqlite: Database): void {
  sqlite.loadExtension(getLoadablePath());
}

/**
 * Create projection tables, FTS5, and (optionally) the vec0 table.
 * Idempotent; safe to call on an already-initialized database.
 */
export function initSchema(sqlite: Database): void {
  // Event store (append-only, raw SQL — ADR-0002).
  createEventsTable(sqlite);

  // Projection tables (mirror of src/db/schema.ts; created via raw DDL so init
  // needs no drizzle-kit step at runtime — drop+rebuild semantics, ADR-0002).
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS sources (
      external_id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      body        TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      meta        TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL,
      state      TEXT NOT NULL DEFAULT 'proposed',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS decisions (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      rationale   TEXT NOT NULL DEFAULT '',
      recorded_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS inbox (
      id                 TEXT PRIMARY KEY,
      source_external_id TEXT NOT NULL,
      state              TEXT NOT NULL DEFAULT 'open',
      updated_at         TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS proposals (
      candidate_id TEXT PRIMARY KEY,
      mode         TEXT NOT NULL,
      kind         TEXT NOT NULL,
      entity_id    TEXT NOT NULL,
      summary      TEXT NOT NULL DEFAULT '',
      state        TEXT NOT NULL DEFAULT 'pending',
      reason       TEXT NOT NULL DEFAULT '',
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );
    -- propose.apply flips a pending proposal to applied by matching entity_id.
    CREATE INDEX IF NOT EXISTS idx_proposals_entity ON proposals(entity_id);
    CREATE TABLE IF NOT EXISTS commitments (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      direction   TEXT NOT NULL,
      state       TEXT NOT NULL DEFAULT 'open',
      due_date    TEXT,
      person      TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    -- commitment.list filters by state (open/resolved/dismissed); index it.
    CREATE INDEX IF NOT EXISTS idx_commitments_state ON commitments(state);
    CREATE TABLE IF NOT EXISTS links (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      from_kind TEXT NOT NULL,
      from_id   TEXT NOT NULL,
      to_kind   TEXT NOT NULL,
      to_id     TEXT NOT NULL,
      relation  TEXT NOT NULL,
      -- Stable id for a manual link (manual_link, ADR-0018 追補 / #90); NULL for
      -- reducer-derived edges. link.remove deletes by this id.
      link_id   TEXT
    );
    -- Graph traversal (graph.related / graph.expand, ADR-0018) looks up edges by
    -- endpoint in both directions; index each side.
    CREATE INDEX IF NOT EXISTS idx_links_from ON links(from_kind, from_id);
    CREATE INDEX IF NOT EXISTS idx_links_to   ON links(to_kind, to_id);
    -- Manual links are addressed by their stable link_id (link.remove); index it.
    CREATE INDEX IF NOT EXISTS idx_links_link_id ON links(link_id);
    -- Person identity resolution (ADR-0022): persons + their connector identities.
    CREATE TABLE IF NOT EXISTS persons (
      id             TEXT PRIMARY KEY,
      display_name   TEXT NOT NULL DEFAULT '',
      identity_count INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS person_identities (
      identity_key TEXT PRIMARY KEY,
      person_id    TEXT NOT NULL,
      connector    TEXT NOT NULL,
      handle       TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      observed_at  TEXT NOT NULL
    );
    -- person.list groups identities by person; index the FK for the grouping.
    CREATE INDEX IF NOT EXISTS idx_person_identities_person ON person_identities(person_id);
  `);

  // FTS5 over source bodies. Trigram tokenizer captures Japanese/English
  // substrings without a CJK word segmenter (ADR-0005, docs/design/retrieval.md).
  // `content=''` makes it a contentless (external-content-free) index we
  // populate explicitly from the reducer.
  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS sources_fts USING fts5(
      external_id UNINDEXED,
      body,
      tokenize = 'trigram'
    );
  `);
}

/** Sidecar table recording which model produced each stored vector (ADR-0006). */
export const VEC_META_TABLE = "embeddings_meta";

/** Create the default vec0 table. Requires the sqlite-vec extension loaded. */
export function initVecTable(sqlite: Database, dim: number = DEFAULT_EMBEDDING_DIM): void {
  // vec0 is a cheap substrate kept regardless of backend; populate is gated on
  // the embedding backend being enabled (ADR-0005).
  sqlite.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${DEFAULT_VEC_TABLE} USING vec0(
      external_id TEXT PRIMARY KEY,
      embedding float[${dim}]
    );`,
  );
  // Provenance sidecar for the maintenance verbs (status / rebuild / drain,
  // ADR-0006). vec0 stores only (external_id, embedding) with no room for the
  // model identity, so a plain table records which model produced each vector.
  // It is a derived substrate (not events, ADR-0002): populated alongside the
  // vector on ingest, dropped and repopulated by `embeddings rebuild`. `model_id`
  // pins the vector space; `model_version` lets a model upgrade (same id, newer
  // build) be detected as stale even when `model_id` is unchanged.
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS ${VEC_META_TABLE} (
      external_id   TEXT PRIMARY KEY,
      model_id      TEXT NOT NULL,
      model_version TEXT NOT NULL DEFAULT '',
      embedded_at   TEXT NOT NULL
    );`,
  );
}

/**
 * Open a database, apply pragmas, load extensions, and initialize the schema.
 */
export function openDatabase(options: OpenOptions): SuasorDb {
  const sqlite = new Database(options.path, { create: true });
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");

  const enableVec = options.enableVec ?? true;
  if (enableVec) {
    loadVecExtension(sqlite);
  }

  initSchema(sqlite);
  if (enableVec) {
    initVecTable(sqlite, options.embeddingDim ?? DEFAULT_EMBEDDING_DIM);
  }

  const orm = drizzle(sqlite, { schema });
  return {
    sqlite,
    orm,
    close: () => sqlite.close(),
  };
}
