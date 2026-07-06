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
 *     character queries (common in Japanese, e.g. 区, 東京) still return hits.
 *     Each token becomes its own ANDed `LIKE '%token%'` predicate — a multi-token
 *     short query like "予算 承認" then matches documents containing *both*
 *     tokens, rather than the whole query as one contiguous substring (which
 *     included the space and near-guaranteed zero hits in spaceless Japanese —
 *     retrieval-2). Ranking is a crude token-occurrence count (docs/design/
 *     retrieval.md "短クエリ fallback").
 *
 * Both paths handle JA and EN uniformly: trigram captures CJK substrings without
 * a word segmenter, and LIKE is byte/codepoint substring matching.
 *
 * Payload: every hit carries a bounded `excerpt` (not the full body) by default,
 * so a multi-hit response can't overflow a host's context window; the full body
 * is fetched via `source.get` (ADR-0018 payload suppression / retrieval-m2).
 * Pass `fullBody` to opt back into the full body per hit.
 */
import type { Database } from "bun:sqlite";

/** Trigram tokenizer n-gram length: queries shorter than this can't MATCH. */
export const TRIGRAM_LENGTH = 3;

/** Default maximum number of hits returned. */
export const DEFAULT_SEARCH_LIMIT = 20;

/**
 * Default excerpt length (in code points) for a bounded hit body. A search
 * response carries an excerpt of at most this many characters per hit unless
 * `fullBody` is set, so a multi-hit response stays small enough not to overflow
 * the host context (retrieval-m2 / ADR-0018 payload suppression).
 */
export const DEFAULT_EXCERPT_CHARS = 240;

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
   * negative value is more relevant. For the LIKE fallback it is the total
   * occurrence count of the query tokens in the body (higher = more relevant).
   * Either way hits are returned best-first, but the direction differs by path,
   * so read {@link SearchResult.strategy} before comparing scores.
   */
  score: number;
  /**
   * Bounded excerpt of the source body — the default payload (retrieval-m2 /
   * ADR-0018 payload suppression). Present unless `fullBody` was requested. For
   * a lexical hit the window is centred on the first matching token; otherwise
   * it is the leading {@link SearchOptions.maxBodyChars} characters. Fetch the
   * full text via `source.get`.
   */
  excerpt?: string;
  /**
   * Full source body held locally (ADR-0003). Present only when `fullBody` was
   * requested; omitted by default so search responses stay bounded.
   */
  body?: string;
}

export interface SearchResult {
  /** Ranked hits, best-first. Empty when there are no matches. */
  hits: SearchHit[];
  /** Which retrieval path produced the hits (for observability/tests). */
  strategy: SearchStrategy;
  /**
   * Total number of matches before the `limit` was applied. Lets a caller tell
   * "20/20 truncated" apart from "5/5 complete" (ADR-0007 "no silent wrong
   * answer"): `hits.length` is the returned slice, `totalHits` is the full
   * count. Always `>= hits.length`.
   */
  totalHits: number;
  /** `true` when matches were cut off by `limit` (`totalHits > hits.length`). */
  truncated: boolean;
  /**
   * The tokens the query was actually analyzed into for retrieval — the
   * whitespace-split tokens on both paths. For FTS they drive the trigram MATCH;
   * for the LIKE fallback each token is an ANDed `LIKE '%token%'` predicate.
   * Surfaces *what was searched* so a thin/empty result has a visible cause.
   */
  analyzedQuery: string[];
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
  /**
   * Return each hit's full `body` instead of a bounded `excerpt` (opt-in,
   * retrieval-m2). Default `false` — responses carry only the excerpt and the
   * full text is fetched via `source.get` (ADR-0018 payload suppression).
   */
  fullBody?: boolean;
  /** Max characters per bounded excerpt (default {@link DEFAULT_EXCERPT_CHARS}). */
  maxBodyChars?: number;
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

/**
 * Build a bounded excerpt from a source body (retrieval-m2 / ADR-0018).
 *
 * A body already within `maxChars` is returned unchanged. Otherwise, when one of
 * `tokens` occurs in the body the window is centred on the first match
 * (`…match…`); with no token match (semantic recall, or a trigram/case mismatch)
 * the leading `maxChars` characters are returned. Length is counted in code
 * points so a CJK character counts as one, and a leading/trailing `…` marks each
 * side that was cut.
 */
export function buildExcerpt(body: string, maxChars: number, tokens: string[] = []): string {
  const cps = [...body];
  if (cps.length <= maxChars) return body;

  // Locate the first matching token (case-insensitive) to centre the window on.
  const lowerBody = body.toLowerCase();
  let matchUnit = -1;
  for (const t of tokens) {
    if (t.length === 0) continue;
    const idx = lowerBody.indexOf(t.toLowerCase());
    if (idx >= 0 && (matchUnit === -1 || idx < matchUnit)) matchUnit = idx;
  }
  if (matchUnit === -1) {
    return `${cps.slice(0, maxChars).join("")}…`;
  }

  // `indexOf` yields a UTF-16 code-unit offset; convert it to a code-point index
  // so slicing stays aligned even across astral-plane characters.
  const matchCp = [...body.slice(0, matchUnit)].length;
  const half = Math.floor(maxChars / 2);
  const end = Math.min(cps.length, Math.max(0, matchCp - half) + maxChars);
  const start = Math.max(0, end - maxChars);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < cps.length ? "…" : "";
  return `${prefix}${cps.slice(start, end).join("")}${suffix}`;
}

/** How each hit's body is projected into the response (excerpt vs full body). */
interface HitProjection {
  /** Return the full body (`true`) or a bounded excerpt (`false`, default). */
  fullBody: boolean;
  /** Max excerpt length in code points. */
  maxChars: number;
  /** Query tokens used to centre a lexical excerpt on the first match. */
  tokens: string[];
}

interface BodyRow {
  external_id: string;
  source_type: string;
  observed_at: string;
  body: string;
}

/** Map a joined row + score into a {@link SearchHit}, projecting the body. */
function toSearchHit(row: BodyRow, score: number, proj: HitProjection): SearchHit {
  const hit: SearchHit = {
    externalId: row.external_id,
    sourceType: row.source_type,
    observedAt: row.observed_at,
    score,
  };
  if (proj.fullBody) hit.body = row.body;
  else hit.excerpt = buildExcerpt(row.body, proj.maxChars, proj.tokens);
  return hit;
}

interface FtsRow {
  external_id: string;
  source_type: string;
  observed_at: string;
  body: string;
  rank: number;
}

interface CountRow {
  total: number;
}

/** FTS5 path: trigram MATCH over `sources_fts`, ranked by bm25 (best-first). */
function searchFts(
  sqlite: Database,
  query: string,
  limit: number,
  filters: SearchFilters,
  proj: HitProjection,
): { hits: SearchHit[]; totalHits: number } {
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
  // Count the full match set (pre-limit) so callers can detect truncation. Only
  // run the extra COUNT when the page is full — a short page can't be truncated.
  const totalHits =
    rows.length < limit
      ? rows.length
      : (sqlite
          .query<CountRow, (string | number)[]>(
            `SELECT COUNT(*) AS total
               FROM sources_fts
               JOIN sources s ON s.external_id = sources_fts.external_id
              WHERE ${where}`,
          )
          .get(match, ...params)?.total ?? rows.length);
  const hits = rows.map((r) => toSearchHit(r, r.rank, proj));
  return { hits, totalHits };
}

interface LikeRow extends BodyRow {
  /** Total occurrence count of the query tokens in the body (crude relevance). */
  occ: number;
}

/**
 * Short-query fallback: per-token `LIKE` substring scan over `sources.body`.
 *
 * Used when the query is too short for the trigram index. Each token becomes its
 * own ANDed `LIKE '%token%'` predicate, so a multi-token query like "予算 承認"
 * matches documents containing *both* tokens anywhere — rather than the whole
 * query as one contiguous substring (space included), which near-guaranteed zero
 * hits in spaceless Japanese (retrieval-2). There is no statistical rank, so
 * hits are ordered by a crude total token-occurrence count (desc), with the most
 * recently observed first as a tiebreaker; the score is that occurrence count.
 */
function searchLikeFallback(
  sqlite: Database,
  tokens: string[],
  limit: number,
  filters: SearchFilters,
  proj: HitProjection,
): { hits: SearchHit[]; totalHits: number } {
  // One ANDed LIKE predicate per token (retrieval-2). `%`/`_`/`\` are escaped so
  // the token is matched literally, with `ESCAPE '\'`.
  const tokenClauses = tokens.map(() => "body LIKE ? ESCAPE '\\'");
  const tokenParams = tokens.map((t) => `%${escapeLike(t)}%`);
  // No alias here (single-table scan), so qualify the filter columns with the
  // table name to keep the generated SQL unambiguous and consistent.
  const { clauses, params } = buildFilterClauses(filters, "sources");
  const where = [...tokenClauses, ...clauses].join(" AND ");
  // Crude relevance: the total (non-overlapping) occurrence count of the tokens
  // across the body, via length(body) - length(replace(body, token, '')) over
  // length(token). lower() on both sides keeps the count case-insensitive for
  // ASCII (consistent with LIKE) and is a no-op for CJK; SQLite `length()`
  // counts code points so the division is exact.
  const occExpr = tokens
    .map(() => "(length(lower(body)) - length(replace(lower(body), lower(?), ''))) / length(?)")
    .join(" + ");
  const occParams: string[] = [];
  for (const t of tokens) occParams.push(t, t);
  const rows = sqlite
    .query<LikeRow, (string | number)[]>(
      `SELECT external_id, source_type, observed_at, body,
              ${occExpr} AS occ
         FROM sources
        WHERE ${where}
        ORDER BY occ DESC, observed_at DESC
        LIMIT ?`,
    )
    .all(...occParams, ...tokenParams, ...params, limit);
  const totalHits =
    rows.length < limit
      ? rows.length
      : (sqlite
          .query<CountRow, (string | number)[]>(
            `SELECT COUNT(*) AS total FROM sources WHERE ${where}`,
          )
          .get(...tokenParams, ...params)?.total ?? rows.length);
  const hits = rows.map((r) => toSearchHit(r, r.occ, proj));
  return { hits, totalHits };
}

/**
 * Search ingested source bodies (FTS-first, FR-RET-1).
 *
 * Returns ranked hits best-first along with transparency fields (`totalHits` /
 * `truncated` / `analyzedQuery`) so callers can distinguish a complete result
 * set from a `limit`-truncated one and see what the query tokenized to. An empty
 * or whitespace-only query yields no hits (and reports the `fts` strategy). The
 * retrieval path is chosen by the
 * *longest* token length: if even the longest token is too short for the
 * trigram index (< {@link TRIGRAM_LENGTH}) the per-token LIKE fallback runs
 * (each token ANDed as its own substring predicate), otherwise FTS5 MATCH runs.
 *
 * Every hit carries a bounded `excerpt` by default; pass `fullBody` for the full
 * body or `maxBodyChars` to size the excerpt (retrieval-m2 / ADR-0018).
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
  const projBase = {
    fullBody: options.fullBody ?? false,
    maxChars: options.maxBodyChars ?? DEFAULT_EXCERPT_CHARS,
  };
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return { hits: [], strategy: "fts", totalHits: 0, truncated: false, analyzedQuery: [] };
  }

  const tokens = trimmed.split(/\s+/).filter((t) => t.length > 0);

  // The trigram index can only match a token once it is >= 3 code points. If
  // the *longest* token is still too short, MATCH would return nothing, so we
  // use the per-token LIKE substring fallback for the whole query instead.
  const longestToken = tokens.reduce((max, t) => Math.max(max, codePointLength(t)), 0);
  if (longestToken < TRIGRAM_LENGTH) {
    const { hits, totalHits } = searchLikeFallback(sqlite, tokens, limit, filters, {
      ...projBase,
      tokens,
    });
    return {
      hits,
      strategy: "like-fallback",
      totalHits,
      truncated: totalHits > hits.length,
      analyzedQuery: tokens,
    };
  }

  const { hits, totalHits } = searchFts(sqlite, trimmed, limit, filters, { ...projBase, tokens });
  return {
    hits,
    strategy: "fts",
    totalHits,
    truncated: totalHits > hits.length,
    analyzedQuery: tokens,
  };
}
