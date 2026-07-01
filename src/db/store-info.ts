/**
 * Store health snapshot — event count / projection row counts / DB file size /
 * vec0 count / FTS scale (Issue #202, ADR-0002 / ADR-0005).
 *
 * `suasor doctor` answers "what is wired and what is missing" but says nothing
 * about *how big* the store is or whether the optional substrates (vec0, FTS)
 * are populated. This module reads those magnitudes so an operator can spot a
 * runaway event log, an empty FTS index, or a half-populated vec0 table.
 *
 * Read-only: every query is a `COUNT(*)` / `PRAGMA` / file `stat`. The vec0 and
 * FTS counts degrade gracefully — a store opened with `enableVec: false` (or an
 * old DB lacking the table) reports `null` rather than throwing, so the snapshot
 * works on any migrated store.
 */
import type { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { DEFAULT_VEC_TABLE, VEC_META_TABLE } from "./connection.ts";
import { countEventRows } from "./events-table.ts";

/** Projection tables surfaced in the store-info row-count table (schema.ts). */
const PROJECTION_TABLES = [
  "sources",
  "tasks",
  "decisions",
  "inbox",
  "proposals",
  "commitments",
  "links",
  "persons",
  "person_identities",
  "slack_channels",
  "slack_teams",
] as const;

/** Per-projection-table row count. */
export interface ProjectionCount {
  /** Projection table name. */
  table: string;
  /** Number of rows currently in the table. */
  rows: number;
}

/** Per-event-type count in the append-only log (Issue #270). */
export interface EventTypeCount {
  /** Event discriminator (`events.type`, e.g. `SourceObserved`). */
  type: string;
  /** Number of events of this type in the log. */
  count: number;
}

/** Store health snapshot returned by {@link storeInfo}. */
export interface StoreInfo {
  /** Absolute path of the SQLite database file (`null` for an in-memory DB). */
  dbPath: string | null;
  /** Total size in bytes of the DB file + its WAL / SHM sidecars (`null` for in-memory). */
  fileSizeBytes: number | null;
  /** Number of events in the append-only log (single source of truth, ADR-0002). */
  events: number;
  /** Row count per projection table, sorted by table name. */
  projections: ProjectionCount[];
  /** Vectors stored in vec0 (`null` when the vec0 table is absent). */
  vectors: number | null;
  /** Rows in the `embeddings_meta` provenance sidecar (`null` when absent). */
  embeddingsMeta: number | null;
  /** Rows in the FTS5 index over source bodies (`null` when the table is absent). */
  ftsRows: number | null;
}

/**
 * Count events grouped by their discriminator (`events.type`), descending by
 * count then ascending by type for a stable, readable order (Issue #270).
 *
 * Read-only: a single `COUNT(*) ... GROUP BY type` over the append-only log
 * (ADR-0002). Useful for rebuild/replay debugging and for seeing the source
 * mix at a glance without parsing payloads. Backed by `idx_events_type`.
 */
export function eventTypeBreakdown(sqlite: Database): EventTypeCount[] {
  return sqlite
    .query<EventTypeCount, []>(
      "SELECT type, COUNT(*) AS count FROM events GROUP BY type ORDER BY count DESC, type ASC",
    )
    .all();
}

/** Count rows in a table, returning `null` if the table does not exist. */
function countOrNull(sqlite: Database, table: string): number | null {
  const exists = sqlite
    .query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type IN ('table','view') AND name = ?",
    )
    .get(table);
  if (!exists || exists.n === 0) return null;
  const row = sqlite.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get();
  return row?.n ?? 0;
}

/** Sum the byte size of the DB file and its WAL / SHM sidecars (best-effort). */
function fileSize(dbPath: string): number {
  let total = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      total += statSync(`${dbPath}${suffix}`).size;
    } catch {
      // Sidecar (or the file itself) may not exist; skip it.
    }
  }
  return total;
}

/**
 * Compute a read-only store health snapshot.
 *
 * `dbPath` is the on-disk path (pass `null` / `":memory:"` for an in-memory
 * store, which omits the file-size measurement). Projection row counts cover the
 * core nine tables; the vec0 / `embeddings_meta` / FTS counts are `null` when
 * the corresponding substrate is absent (e.g. a store opened without vec).
 */
export function storeInfo(sqlite: Database, dbPath: string | null): StoreInfo {
  const onDisk = dbPath !== null && dbPath !== ":memory:";
  return {
    dbPath: onDisk ? dbPath : null,
    fileSizeBytes: onDisk ? fileSize(dbPath) : null,
    events: countEventRows(sqlite),
    projections: PROJECTION_TABLES.map((table) => ({
      table,
      rows: countOrNull(sqlite, table) ?? 0,
    })),
    vectors: countOrNull(sqlite, DEFAULT_VEC_TABLE),
    embeddingsMeta: countOrNull(sqlite, VEC_META_TABLE),
    ftsRows: countOrNull(sqlite, "sources_fts"),
  };
}

/** Format a byte count as a human-readable string (e.g. `1.5 MB`). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
