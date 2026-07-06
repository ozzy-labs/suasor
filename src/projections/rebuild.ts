/**
 * Projection rebuild: replay all events to reconstruct read models (ADR-0002).
 *
 * `suasor projections rebuild` truncates every projection table (including the
 * `sources_fts` index) and re-applies the full event log via the same reducer
 * used for live appends. Because the reducer is deterministic and the event log
 * is the source of truth, the rebuilt projections are value-identical to the
 * pre-rebuild state (rebuild idempotence — FR-MNT-1).
 *
 * The embedding sidecar (the `vec0` vectors AND their `embeddings_meta`
 * provenance rows) is the one exception: vectors are produced by the delegated
 * embedder (ADR-0006), not carried in the event payload, so replay cannot
 * reproduce them. Rebuild therefore *clears both substrates together* and leaves
 * an honest "all pending" state (ADR-0005 §5). They must be cleared symmetrically:
 * clearing only `vec0` while leaving `embeddings_meta` would make `embeddings
 * status` / `doctor` / `drain` all report full coverage (a meta row per source)
 * while every vector is gone, so semantic recall silently returns empty with no
 * repair path. Recovery is a one-shot `suasor embeddings drain` — NOT the next
 * `<connector> sync`, which only (re)embeds new or changed sources and would
 * leave every unchanged source permanently pending.
 *
 * The whole operation runs in a single transaction so a failure leaves the
 * existing projections intact.
 */
import type { Database } from "bun:sqlite";
import { DEFAULT_VEC_TABLE, VEC_META_TABLE } from "../db/connection.ts";
import { readAllEvents } from "../events/store.ts";
import { applyEvents, rebuildSourcesFts } from "./reducer.ts";

/** Projection tables cleared before replay (the event store is untouched). */
const PROJECTION_TABLES = [
  "sources",
  "forgotten_sources",
  "tasks",
  "sync_runs",
  "decisions",
  "inbox",
  "proposals",
  "commitments",
  "links",
  "persons",
  "person_identities",
  "slack_channels",
  "slack_teams",
  "sources_fts",
];

/**
 * Delete all rows from the projection tables (event store is preserved). The
 * embedding sidecar — the vec0 vectors AND their `embeddings_meta` provenance
 * rows — is cleared too when present, since neither is replayable from the event
 * log (both come from the delegated embedder, ADR-0006). The two must be cleared
 * *together*: leaving `embeddings_meta` behind would make the maintenance verbs
 * report full coverage while the vectors are gone, silently breaking recall
 * (ADR-0005 §5).
 *
 * Returns the number of embedding rows that existed before clearing (the larger
 * of the two substrates' counts), so the caller can prompt for a `suasor
 * embeddings drain` only when recall was actually invalidated.
 */
export function truncateProjections(sqlite: Database): number {
  for (const table of PROJECTION_TABLES) {
    sqlite.exec(`DELETE FROM ${table};`);
  }
  // vec0 / embeddings_meta exist only when an embedding substrate was created
  // (openDatabase with enableVec); guard so rebuild also works on a vec-less
  // store. Count each before clearing so the CLI can report how many vectors
  // recall lost (they usually match; a pre-fix rebuild could have left them
  // diverged, which `doctor` now flags — ADR-0005 §5).
  let clearedEmbeddings = 0;
  for (const table of [DEFAULT_VEC_TABLE, VEC_META_TABLE]) {
    const exists = sqlite
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(table);
    if (!exists) continue;
    const { n } = sqlite.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get() ?? {
      n: 0,
    };
    clearedEmbeddings = Math.max(clearedEmbeddings, n);
    sqlite.exec(`DELETE FROM ${table};`);
  }
  return clearedEmbeddings;
}

export interface RebuildResult {
  /** Number of events replayed. */
  events: number;
  /**
   * Embedding rows (vec0 vectors / `embeddings_meta` provenance) cleared by the
   * rebuild. Non-zero means semantic recall is now empty until a `suasor
   * embeddings drain` re-embeds those sources (ADR-0005 §5). Zero on an
   * embedding-less / never-embedded store.
   */
  clearedEmbeddings: number;
}

/** Options for {@link rebuildProjections}. */
export interface RebuildOptions {
  /**
   * Invoked once per replayed event so a long rebuild can surface progress.
   * Replay runs in a single transaction; the callback only observes, it must not
   * touch the DB. A no-op when omitted (the default).
   */
  onProgress?: () => void;
}

/**
 * Rebuild all projections from the event log. Atomic: on error the prior
 * projections are rolled back.
 */
export function rebuildProjections(sqlite: Database, options: RebuildOptions = {}): RebuildResult {
  const events = readAllEvents(sqlite);
  let clearedEmbeddings = 0;
  const tx = sqlite.transaction(() => {
    clearedEmbeddings = truncateProjections(sqlite);
    // Defer FTS during replay: a source updated K times would otherwise be
    // reindexed K times (all but the last wasted). Replay touches only `sources`,
    // then we rebuild the FTS index once from the final state — O(sources) not
    // O(events). truncateProjections already emptied sources_fts, so the bulk
    // insert below reproduces exactly what per-event syncing would have left.
    applyEvents(sqlite, events, options.onProgress, { deferFts: true });
    rebuildSourcesFts(sqlite);
  });
  tx();
  return { events: events.length, clearedEmbeddings };
}
