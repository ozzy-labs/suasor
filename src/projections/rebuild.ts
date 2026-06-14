/**
 * Projection rebuild: replay all events to reconstruct read models (ADR-0002).
 *
 * `suasor projections rebuild` truncates every projection table (including the
 * `sources_fts` index) and re-applies the full event log via the same reducer
 * used for live appends. Because the reducer is deterministic and the event log
 * is the source of truth, the rebuilt projections are value-identical to the
 * pre-rebuild state (rebuild idempotence — FR-MNT-1).
 *
 * The whole operation runs in a single transaction so a failure leaves the
 * existing projections intact.
 */
import type { Database } from "bun:sqlite";
import { readAllEvents } from "../events/store.ts";
import { applyEvents } from "./reducer.ts";

/** Projection tables cleared before replay (the event store is untouched). */
const PROJECTION_TABLES = ["sources", "tasks", "decisions", "inbox", "links", "sources_fts"];

/** Delete all rows from the projection tables (event store is preserved). */
export function truncateProjections(sqlite: Database): void {
  for (const table of PROJECTION_TABLES) {
    sqlite.exec(`DELETE FROM ${table};`);
  }
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
