/**
 * Append-only event store (raw SQL, ADR-0002).
 *
 * The `events` table is the single source of truth. It is intentionally NOT
 * Drizzle-managed: the append path is raw `bun:sqlite` for simplicity and to
 * keep the store decoupled from the (rebuildable) projection schema.
 *
 * Ordering: a monotonically increasing `seq` (AUTOINCREMENT) defines the total
 * replay order. The Zod `id` is a separate stable event identifier. Replay
 * reads strictly in `seq` order so projections rebuild deterministically.
 *
 * Payload: the full validated event (including envelope) is stored as JSON in
 * `payload`. Discriminator (`type`) and `schema_version` are duplicated into
 * columns for cheap filtering without parsing every row.
 */
import type { Database } from "bun:sqlite";

/** A persisted event row as read back from the store. */
export interface StoredEventRow {
  seq: number;
  id: string;
  type: string;
  schema_version: number;
  recorded_at: string;
  payload: string;
}

/** Create the append-only events table. Idempotent (`IF NOT EXISTS`). */
export function createEventsTable(sqlite: Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS events (
      seq            INTEGER PRIMARY KEY AUTOINCREMENT,
      id             TEXT NOT NULL UNIQUE,
      type           TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      recorded_at    TEXT NOT NULL,
      payload        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
  `);
}

/** Insert one event row. The caller supplies a fully validated event payload. */
export function insertEventRow(
  sqlite: Database,
  row: { id: string; type: string; schemaVersion: number; recordedAt: string; payload: string },
): void {
  sqlite
    .query(
      `INSERT INTO events (id, type, schema_version, recorded_at, payload)
       VALUES ($id, $type, $schema_version, $recorded_at, $payload)`,
    )
    .run({
      $id: row.id,
      $type: row.type,
      $schema_version: row.schemaVersion,
      $recorded_at: row.recordedAt,
      $payload: row.payload,
    });
}

/** Read all events in replay (`seq` ascending) order. */
export function readAllEventRows(sqlite: Database): StoredEventRow[] {
  return sqlite
    .query<StoredEventRow, []>(
      "SELECT seq, id, type, schema_version, recorded_at, payload FROM events ORDER BY seq ASC",
    )
    .all();
}

/** Count stored events. */
export function countEventRows(sqlite: Database): number {
  const row = sqlite.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get();
  return row?.n ?? 0;
}
