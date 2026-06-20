/**
 * FTS-first search service (ADR-0005 / docs/design/retrieval.md, FR-RET-1).
 *
 * The default retrieval path. Turns a free-text query into ranked hits over the
 * `sources_fts` FTS5 index (trigram tokenizer), joined back to the `sources`
 * projection for metadata. This is the substrate the MCP `search` read tool
 * (#8) and the `suasor search` CLI build on; it has no side effects.
 *
 * Two query paths:
 *  1. FTS5 MATCH (default) — for queries whose shortest token is long enough for
 *     the trigram index (>= 3 chars). Ranking is SQLite `bm25` (lower = better).
 *  2. Short-query fallback — the trigram tokenizer indexes 3-grams, so a query
 *     token shorter than 3 chars can never MATCH (returns nothing). For those we
 *     fall back to a `LIKE` substring scan over `sources.body`, so single/double
 *     character queries (common in Japanese, e.g. 区, 東京) still return hits
 *     (docs/design/retrieval.md "短クエリ fallback").
 *
 * Both paths handle JA and EN uniformly: trigram captures CJK substrings without
 * a word segmenter, and LIKE is byte/codepoint substring matching.
 */
import type { Database } from "bun:sqlite";

/** Trigram tokenizer n-gram length: queries shorter than this can't MATCH. */
export const TRIGRAM_LENGTH = 3;

/** Default maximum number of hits returned. */
export const DEFAULT_SEARCH_LIMIT = 20;

/** How a hit was retrieved (which path produced it). */
export type SearchStrategy = "fts" | "like-fallback";

/** A single ranked search hit. */
export interface SearchHit {
  /** Connector-assigned source id (ADR-0007). */
  externalId: string;
  /** Projection `source_type` (e.g. "github_issue"). */
  sourceType: string;
  /** When the source was observed at its origin (ISO 8601). */
  observedAt: string;
  /**
   * Relevance score. For FTS hits this is the SQLite `bm25` rank where a more
   * negative value is more relevant; results are returned best-first. The
   * LIKE fallback has no statistical ranking, so all fallback hits share a
   * single sentinel score (`0`) and are ordered by recency instead.
   */
  score: number;
  /** Full source body held locally (ADR-0003). */
  body: string;
}

export interface SearchResult {
  /** Ranked hits, best-first. Empty when there are no matches. */
  hits: SearchHit[];
  /** Which retrieval path produced the hits (for observability/tests). */
  strategy: SearchStrategy;
}

/**
 * Optional metadata filters applied to both retrieval paths (FTS + LIKE
 * fallback). They narrow the candidate `sources` rows by joining the FTS hits
 * back to the projection; the ranking within the narrowed set is unchanged.
 *
 * The time window matches the projection read-tool convention (queries.ts /
 * docs/skills): the lower bound is inclusive (`>=`) and the upper bound is
 * exclusive (`<`), so adjacent windows don't double-count. Bounds compare ISO
 * 8601 strings lexicographically (valid for zero-padded UTC timestamps).
 */
export interface SearchFilters {
  /** Restrict to a single `source_type` (e.g. "github_issue"). */
  sourceType?: string;
  /** Inclusive lower bound on `observed_at` (ISO 8601). */
  observedAfter?: string;
  /** Exclusive upper bound on `observed_at` (ISO 8601). */
  observedBefore?: string;
}

export interface SearchOptions extends SearchFilters {
  /** Maximum hits to return (default {@link DEFAULT_SEARCH_LIMIT}). */
  limit?: number;
}

/**
 * Build the `source_type` / `observed_at` filter clauses (qualified by the given
 * table alias) plus their bound params, in a stable order so callers can splice
 * them into either query path. Inclusive lower bound (`>=`), exclusive upper
 * bound (`<`) — the projection time-filter convention (queries.ts).
 */
function buildFilterClauses(
  filters: SearchFilters,
  alias: string,
): { clauses: string[]; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filters.sourceType !== undefined) {
    clauses.push(`${alias}.source_type = ?`);
    params.push(filters.sourceType);
  }
  if (filters.observedAfter !== undefined) {
    clauses.push(`${alias}.observed_at >= ?`);
    params.push(filters.observedAfter);
  }
  if (filters.observedBefore !== undefined) {
    clauses.push(`${alias}.observed_at < ?`);
    params.push(filters.observedBefore);
  }
  return { clauses, params };
}

/** Count Unicode code points (so CJK chars count as 1, not their byte length). */
function codePointLength(s: string): number {
  return [...s].length;
}

/**
 * Build a safe FTS5 MATCH expression from a free-text query.
 *
 * Each whitespace-separated token becomes a quoted phrase so user input is
 * treated as literal text — FTS5 operators (`AND`/`OR`/`NOT`/`*`/`(`/`:`/`-`)
 * inside a token can't inject query syntax or raise a syntax error. Embedded
 * double quotes are escaped per FTS5 rules (`"` -> `""`). Tokens are ANDed
 * (the default FTS5 connective) by listing the phrases space-separated.
 */
export function buildFtsMatch(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => `"${t.replaceAll('"', '""')}"`)
    .join(" ");
}

/** Escape `%`, `_`, and the chosen escape char for a LIKE pattern. */
function escapeLike(s: string): string {
  return s.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

interface FtsRow {
  external_id: string;
  source_type: string;
  observed_at: string;
  body: string;
  rank: number;
}

/** FTS5 path: trigram MATCH over `sources_fts`, ranked by bm25 (best-first). */
function searchFts(
  sqlite: Database,
  query: string,
  limit: number,
  filters: SearchFilters,
): SearchHit[] {
  const match = buildFtsMatch(query);
  // Metadata filters apply to the joined `sources` row (alias `s`), so they
  // narrow both paths uniformly without touching ranking.
  const { clauses, params } = buildFilterClauses(filters, "s");
  const where = ["sources_fts MATCH ?", ...clauses].join(" AND ");
  const rows = sqlite
    .query<FtsRow, (string | number)[]>(
      `SELECT s.external_id   AS external_id,
              s.source_type   AS source_type,
              s.observed_at   AS observed_at,
              s.body          AS body,
              bm25(sources_fts) AS rank
         FROM sources_fts
         JOIN sources s ON s.external_id = sources_fts.external_id
        WHERE ${where}
        ORDER BY rank ASC
        LIMIT ?`,
    )
    .all(match, ...params, limit);
  return rows.map((r) => ({
    externalId: r.external_id,
    sourceType: r.source_type,
    observedAt: r.observed_at,
    score: r.rank,
    body: r.body,
  }));
}

interface LikeRow {
  external_id: string;
  source_type: string;
  observed_at: string;
  body: string;
}

/**
 * Short-query fallback: `LIKE` substring scan over `sources.body`.
 *
 * Used when the query is too short for the trigram index. There is no relevance
 * signal, so hits are ordered by recency (most recently observed first) and
 * carry a sentinel score of 0.
 */
function searchLikeFallback(
  sqlite: Database,
  query: string,
  limit: number,
  filters: SearchFilters,
): SearchHit[] {
  const pattern = `%${escapeLike(query.trim())}%`;
  // No alias here (single-table scan), so qualify the filter columns with the
  // table name to keep the generated SQL unambiguous and consistent.
  const { clauses, params } = buildFilterClauses(filters, "sources");
  const where = ["body LIKE ? ESCAPE '\\'", ...clauses].join(" AND ");
  const rows = sqlite
    .query<LikeRow, (string | number)[]>(
      `SELECT external_id, source_type, observed_at, body
         FROM sources
        WHERE ${where}
        ORDER BY observed_at DESC
        LIMIT ?`,
    )
    .all(pattern, ...params, limit);
  return rows.map((r) => ({
    externalId: r.external_id,
    sourceType: r.source_type,
    observedAt: r.observed_at,
    score: 0,
    body: r.body,
  }));
}

/**
 * Search ingested source bodies (FTS-first, FR-RET-1).
 *
 * Returns ranked hits best-first. An empty or whitespace-only query yields no
 * hits (and reports the `fts` strategy). The retrieval path is chosen by the
 * *longest* token length: if even the longest token is too short for the
 * trigram index (< {@link TRIGRAM_LENGTH}) the LIKE fallback runs over the
 * whole query, otherwise FTS5 MATCH runs.
 *
 * Note: within an FTS query, tokens shorter than the trigram length are dropped
 * by the tokenizer rather than required (e.g. `go home` effectively matches on
 * `home`); this is inherent to trigram FTS and is acceptable since ranking
 * still surfaces the closest matches first.
 */
export function searchSources(
  sqlite: Database,
  query: string,
  options: SearchOptions = {},
): SearchResult {
  const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
  const filters: SearchFilters = {
    ...(options.sourceType !== undefined ? { sourceType: options.sourceType } : {}),
    ...(options.observedAfter !== undefined ? { observedAfter: options.observedAfter } : {}),
    ...(options.observedBefore !== undefined ? { observedBefore: options.observedBefore } : {}),
  };
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return { hits: [], strategy: "fts" };
  }

  // The trigram index can only match a token once it is >= 3 code points. If
  // the *longest* token is still too short, MATCH would return nothing, so we
  // use the LIKE substring fallback for the whole query instead.
  const longestToken = trimmed
    .split(/\s+/)
    .reduce((max, t) => Math.max(max, codePointLength(t)), 0);
  if (longestToken < TRIGRAM_LENGTH) {
    return { hits: searchLikeFallback(sqlite, trimmed, limit, filters), strategy: "like-fallback" };
  }

  return { hits: searchFts(sqlite, trimmed, limit, filters), strategy: "fts" };
}
