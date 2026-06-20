/**
 * Projection rebuild: replay all events to reconstruct read models (ADR-0002).
 *
 * `suasor projections rebuild` truncates every projection table (including the
 * `sources_fts` index) and re-applies the full event log via the same reducer
 * used for live appends. Because the reducer is deterministic and the event log
 * is the source of truth, the rebuilt projections are value-identical to the
 * pre-rebuild state (rebuild idempotence — FR-MNT-1).
 *
 * The vec0 embedding substrate is the one exception: its vectors are produced by
 * the delegated embedder (ADR-0006), not carried in the event payload, so replay
 * cannot reproduce them. Rebuild therefore *clears* it (no stale vectors survive
 * — fresh-DB-consistent) and the vectors are regenerated on the next
 * `<connector> sync`.
 *
 * The whole operation runs in a single transaction so a failure leaves the
 * existing projections intact.
 */
import type { Database } from "bun:sqlite";
import { DEFAULT_VEC_TABLE } from "../db/connection.ts";
import { readAllEvents } from "../events/store.ts";
import { applyEvents } from "./reducer.ts";

/** Projection tables cleared before replay (the event store is untouched). */
const PROJECTION_TABLES = [
  "sources",
  "tasks",
  "sync_runs",
  "decisions",
  "inbox",
  "proposals",
  "commitments",
  "links",
  "persons",
  "person_identities",
  "sources_fts",
];

/**
 * Delete all rows from the projection tables (event store is preserved). The
 * vec0 embedding substrate is cleared too when present, since its vectors are
 * not replayable from the event log (they come from the delegated embedder,
 * ADR-0006) and must not survive as stale rows across a rebuild.
 */
export function truncateProjections(sqlite: Database): void {
  for (const table of PROJECTION_TABLES) {
    sqlite.exec(`DELETE FROM ${table};`);
  }
  // vec0 exists only when an embedding substrate was created (openDatabase with
  // enableVec); guard so rebuild also works on a vec-less store.
  const vecExists = sqlite
    .query<{ name: string }, [string]>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(DEFAULT_VEC_TABLE);
  if (vecExists) sqlite.exec(`DELETE FROM ${DEFAULT_VEC_TABLE};`);
}

export interface RebuildResult {
  /** Number of events replayed. */
  events: number;
}

/**
 * Rebuild all projections from the event log. Atomic: on error the prior
 * projections are rolled back.
 */
export function rebuildProjections(sqlite: Database): RebuildResult {
  const events = readAllEvents(sqlite);
  const tx = sqlite.transaction(() => {
    truncateProjections(sqlite);
    applyEvents(sqlite, events);
  });
  tx();
  return { events: events.length };
}
