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
      -- Scheduling fields (ADR-0028); NULL when the task carries none. overdue is
      -- NOT stored — it is derived at read time (dueDate < now AND open/in_progress).
      due_date   TEXT,
      priority   TEXT,
      -- External home link (ADR-0036); NULL until the task is published (egress).
      -- Identity link for read-back & loop-avoidance (native task vs its mirror).
      published_destination TEXT,
      published_external_id TEXT,
      published_at          TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    -- Sync run history (ADR-0033): one row per connector = its latest run, so
    -- sync status reads freshness with a constant SELECT instead of scanning
    -- the event log. Folded from SyncRunStarted / SyncRunEnded.
    CREATE TABLE IF NOT EXISTS sync_runs (
      connector   TEXT PRIMARY KEY,
      run_id      TEXT NOT NULL,
      started_at  TEXT NOT NULL,
      ended_at    TEXT,
      status      TEXT NOT NULL,
      observed    INTEGER NOT NULL DEFAULT 0,
      updated     INTEGER NOT NULL DEFAULT 0,
      unchanged   INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER,
      last_error  TEXT
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
    -- Slack channel name projection (ADR-0037 §3): one row per observed
    -- conversation id, name-resolved at sync so display joins ids → names locally
    -- (no-fetch-at-query, ADR-0012). Folded from SlackChannelObserved (LWW).
    CREATE TABLE IF NOT EXISTS slack_channels (
      channel_id  TEXT PRIMARY KEY,
      team_id     TEXT NOT NULL DEFAULT '',
      name        TEXT NOT NULL DEFAULT '',
      kind        TEXT NOT NULL,
      observed_at TEXT NOT NULL
    );
    -- Document-extraction provenance sidecar (ADR-0024). Derived substrate (not
    -- events, ADR-0002): records which extractor version produced a source's
    -- extracted body, so a later extractor upgrade (version bump) or a newly
    -- enabled backend is detected as drift and re-extracted on the next sync.
    -- state is the per-source outcome (extracted / unsupported / too_large).
    CREATE TABLE IF NOT EXISTS extraction_meta (
      external_id  TEXT PRIMARY KEY,
      version      TEXT NOT NULL,
      state        TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );
  `);

  // Additive column migrations for pre-existing databases (ADR-0028). The
  // `CREATE TABLE IF NOT EXISTS` above only applies to a fresh `tasks` table; an
  // existing one needs ADD COLUMN to gain `due_date` / `priority`. SQLite has no
  // `ADD COLUMN IF NOT EXISTS`, so we gate on PRAGMA table_info. Idempotent and
  // non-destructive (the event log is the source of truth — ADR-0002).
  ensureColumn(sqlite, "tasks", "due_date", "TEXT");
  ensureColumn(sqlite, "tasks", "priority", "TEXT");
  // External-home link (ADR-0036) on legacy tables.
  ensureColumn(sqlite, "tasks", "published_destination", "TEXT");
  ensureColumn(sqlite, "tasks", "published_external_id", "TEXT");
  ensureColumn(sqlite, "tasks", "published_at", "TEXT");

  // task.list filters overdue tasks by due_date (ADR-0028); index it. Created
  // after ensureColumn so the column exists on legacy tables too.
  sqlite.exec("CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);");

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

/**
 * Idempotently add a nullable column to an existing table (additive migration,
 * ADR-0028). No-op when the column already exists; SQLite lacks
 * `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so we inspect PRAGMA table_info.
 */
function ensureColumn(sqlite: Database, table: string, column: string, type: string): void {
  const cols = sqlite.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => c.name === column)) return;
  sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type};`);
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
 * Read the vector dimension the default vec0 table was created with, by parsing
 * the `float[N]` width out of its stored `CREATE VIRTUAL TABLE` SQL in
 * `sqlite_master`. Returns `null` when the table is absent (a fresh / FTS-only
 * store) — the caller treats that as "nothing to mismatch against".
 *
 * The vec0 dim is fixed at DB creation (it sizes the table); changing
 * `[embedding].dim` afterwards does NOT resize it, so a config `dim` that differs
 * from this value silently breaks every vector insert (recall degrades to empty,
 * Issue #267 / #294). This read lets validate-config / doctor surface that drift
 * without needing the embedding backend (it is a pure DB read, no egress).
 */
export function readVecDim(sqlite: Database): number | null {
  const row = sqlite
    .query<{ sql: string | null }, [string]>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(DEFAULT_VEC_TABLE);
  if (!row?.sql) return null;
  // sqlite-vec records the column as `embedding float[1024]`; pull the width out.
  const match = row.sql.match(/float\s*\[\s*(\d+)\s*\]/i);
  if (!match) return null;
  const dim = Number(match[1]);
  return Number.isInteger(dim) && dim > 0 ? dim : null;
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
