/**
 * FTS5 search over source bodies (ADR-0005 / docs/design/retrieval.md).
 *
 * `sources_fts` is a contentless FTS5 index (trigram tokenizer) kept in sync by
 * the projection reducer. This module is the default retrieval path: a keyword
 * `MATCH` joined back to `sources` for the projected row. Embedding/semantic
 * search is an optional sidecar layered on top later (recall.search, ADR-0006);
 * with the backend disabled the system stays fully usable via FTS.
 *
 * The query string is bound as a parameter (never interpolated) so it is safe
 * against injection; FTS5 interprets it as a MATCH expression.
 */
import type { Database } from "bun:sqlite";

/** One search hit: the matched source projection plus its FTS rank. */
export interface SearchHit {
  externalId: string;
  sourceType: string;
  body: string;
  observedAt: string;
  /** FTS5 bm25 rank (lower is a better match). */
  rank: number;
}

export interface SearchOptions {
  /** Maximum number of hits to return (default 20). */
  limit?: number;
}

/** Default and maximum hit counts for a single search. */
export const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 100;

/**
 * Run an FTS5 keyword search over source bodies, ranked by bm25.
 *
 * An empty/whitespace-only query returns no hits (FTS5 rejects an empty MATCH).
 * Results are ordered best-match first and capped at `limit` (clamped to
 * `[1, MAX_SEARCH_LIMIT]`).
 */
export function searchSources(
  sqlite: Database,
  query: string,
  options: SearchOptions = {},
): SearchHit[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  const limit = Math.min(Math.max(options.limit ?? DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT);

  return sqlite
    .query<SearchHit, [string, number]>(
      `SELECT
         s.external_id AS externalId,
         s.source_type AS sourceType,
         s.body        AS body,
         s.observed_at AS observedAt,
         bm25(sources_fts) AS rank
       FROM sources_fts
       JOIN sources s ON s.external_id = sources_fts.external_id
       WHERE sources_fts MATCH ?
       ORDER BY rank ASC
       LIMIT ?`,
    )
    .all(trimmed, limit);
}
