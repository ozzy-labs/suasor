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
  "forgotten_sources",
  "tasks",
  "decisions",
  "inbox",
  "proposals",
  "commitments",
  "demand_seen",
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

/**
 * Where source bodies physically live, in bytes (ADR-0047 決定 1).
 *
 * A body is stored in up to four places — every version in `events.payload`,
 * the current version in `sources.body`, its trigram index in `sources_fts`, and
 * its vector in vec0 — and until now `store info` reported only the total file
 * size, which makes the growth question unanswerable: you cannot tell whether a
 * large store is mostly history, mostly index, or mostly vectors, so you cannot
 * tell what a retention policy would actually reclaim.
 *
 * These are content sizes (SUM of LENGTH), not on-disk page usage, so they will
 * not add up exactly to the file size — free pages, per-row overhead and the WAL
 * live outside them. They are meant for **proportions**, not accounting.
 */
export interface BodyStorage {
  /** Total bytes of every event payload (all versions of every body, ADR-0002). */
  eventPayloadBytes: number;
  /** Total bytes of the current body of every source row. */
  sourceBodyBytes: number;
  /** Total bytes held in the FTS5 index blocks (`null` when the index is absent). */
  ftsIndexBytes: number | null;
  /**
   * Estimated bytes of stored vectors — `vectors × dim × 4` (f32). `null` when
   * vec0 is absent or `embeddingDim` was not supplied. An estimate by
   * construction: vec0's on-disk layout adds chunk metadata this does not model.
   */
  vectorBytesEstimate: number | null;
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
  /** Where source bodies live, in bytes (ADR-0047 決定 1). */
  bodyStorage: BodyStorage;
  /**
   * Average growth in bytes per day since the first event, or `null` when the
   * log holds fewer than two distinct days (no slope to measure yet). A crude
   * average, deliberately: the alternative — storing size samples over time —
   * would add a projection whose only purpose is to observe itself.
   */
  bytesPerDay: number | null;
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

/** SUM of a column's byte length, or `null` when the table / column is absent. */
function sumLengthOrNull(sqlite: Database, table: string, column: string): number | null {
  const exists = sqlite
    .query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type IN ('table','view') AND name = ?",
    )
    .get(table);
  if (!exists || exists.n === 0) return null;
  try {
    const row = sqlite
      .query<{ n: number | null }, []>(`SELECT SUM(LENGTH(${column})) AS n FROM ${table}`)
      .get();
    return row?.n ?? 0;
  } catch {
    // A shadow table whose shape differs across SQLite builds must not break the
    // whole snapshot — report "unmeasurable" rather than throwing.
    return null;
  }
}

/**
 * Average bytes/day of growth since the oldest event, or `null` when the log
 * spans less than a day (dividing by ~0 would report a meaningless spike).
 */
function growthPerDay(sqlite: Database, totalBytes: number | null): number | null {
  if (totalBytes === null || totalBytes === 0) return null;
  const row = sqlite
    .query<{ oldest: string | null }, []>("SELECT MIN(recorded_at) AS oldest FROM events")
    .get();
  const oldest = row?.oldest ?? null;
  if (oldest === null) return null;
  const days = (Date.now() - new Date(oldest).getTime()) / (24 * 60 * 60 * 1000);
  if (!Number.isFinite(days) || days < 1) return null;
  return Math.round(totalBytes / days);
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
 * core projection tables; the vec0 / `embeddings_meta` / FTS counts are `null`
 * when the corresponding substrate is absent (e.g. a store opened without vec).
 */
export function storeInfo(
  sqlite: Database,
  dbPath: string | null,
  options: { embeddingDim?: number } = {},
): StoreInfo {
  const onDisk = dbPath !== null && dbPath !== ":memory:";
  const fileSizeBytes = onDisk ? fileSize(dbPath) : null;
  const vectors = countOrNull(sqlite, DEFAULT_VEC_TABLE);
  const dim = options.embeddingDim;
  return {
    dbPath: onDisk ? dbPath : null,
    fileSizeBytes,
    bodyStorage: {
      eventPayloadBytes: sumLengthOrNull(sqlite, "events", "payload") ?? 0,
      sourceBodyBytes: sumLengthOrNull(sqlite, "sources", "body") ?? 0,
      // Contentless FTS5 keeps its index in the `_data` shadow table.
      ftsIndexBytes: sumLengthOrNull(sqlite, "sources_fts_data", "block"),
      vectorBytesEstimate:
        vectors !== null && dim !== undefined && dim > 0 ? vectors * dim * 4 : null,
    },
    bytesPerDay: growthPerDay(sqlite, fileSizeBytes),
    events: countEventRows(sqlite),
    projections: PROJECTION_TABLES.map((table) => ({
      table,
      rows: countOrNull(sqlite, table) ?? 0,
    })),
    vectors,
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
