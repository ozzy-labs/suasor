/**
 * Hybrid retrieval: Reciprocal Rank Fusion of FTS + vec hit lists (ADR-0005
 * range, docs/design/retrieval.md). FTS-first stays the default; hybrid is an
 * additive `search.hybrid` read tool that fuses the two ranked lists so each
 * compensates for the other's blind spot (FTS: exact/lexical; vec: semantic /
 * JA↔EN vocabulary mismatch).
 *
 * RRF (Cormack et al. 2009) fuses *ranks*, not raw scores — which is exactly
 * what we need, since bm25 (lower = better, unbounded) and vec L2 distance
 * (smaller = closer) live on incomparable scales. Each list contributes
 * `1 / (k + rank)` per document (rank is 0-based here), summed across lists.
 * A document hit by both lists accumulates both contributions and so ranks
 * above one hit by only one list, all else equal.
 *
 * Pure + side-effect-free: it takes two already-ranked {@link SearchHit} lists
 * (best-first) and returns a fused, de-duplicated list, so it is trivially
 * unit-testable independent of SQLite / the embedder.
 */
import type { SearchHit } from "./search.ts";

/**
 * RRF damping constant. The canonical value from the original paper; larger `k`
 * flattens the contribution curve (down-weights top ranks relative to the long
 * tail), smaller `k` sharpens it. 60 is the widely-used default.
 */
export const DEFAULT_RRF_K = 60;

/** A fused hit: the underlying source hit plus its computed RRF score. */
export interface HybridHit extends SearchHit {
  /** Reciprocal-rank-fusion score (higher = better; fused list is best-first). */
  rrfScore: number;
}

export interface FuseOptions {
  /** RRF damping constant (default {@link DEFAULT_RRF_K}). */
  k?: number;
  /** Max fused hits to return (default: all). */
  limit?: number;
}

/**
 * Fuse two ranked hit lists with Reciprocal Rank Fusion.
 *
 * Each input list must already be best-first (the order each retrieval path
 * returns). A document's RRF score is the sum over the lists it appears in of
 * `1 / (k + rank)` (0-based rank). Documents are keyed by `externalId`, so the
 * same source hit by both lists is fused into one entry (dedup) carrying the
 * summed score; its `SearchHit` fields are taken from the FTS list when present
 * (its `body`/`score` are the lexical-path values), else from the vec list.
 *
 * The result is sorted by `rrfScore` descending; ties break by `externalId`
 * ascending for a deterministic order. `limit` (when given) trims the tail.
 */
export function fuseRrf(
  ftsHits: SearchHit[],
  vecHits: SearchHit[],
  options: FuseOptions = {},
): HybridHit[] {
  const k = options.k ?? DEFAULT_RRF_K;

  // Accumulate RRF score per externalId, keeping a representative SearchHit.
  // FTS wins as the representative (lexical body/score) when a doc is in both.
  const scores = new Map<string, number>();
  const repr = new Map<string, SearchHit>();

  const accumulate = (hits: SearchHit[], preferAsRepr: boolean) => {
    hits.forEach((hit, rank) => {
      const contribution = 1 / (k + rank);
      scores.set(hit.externalId, (scores.get(hit.externalId) ?? 0) + contribution);
      if (preferAsRepr || !repr.has(hit.externalId)) {
        repr.set(hit.externalId, hit);
      }
    });
  };

  // vec first (fills representatives), then FTS so it overrides as the preferred
  // representative for docs present in both lists.
  accumulate(vecHits, false);
  accumulate(ftsHits, true);

  const fused: HybridHit[] = [...scores.entries()].map(([externalId, rrfScore]) => {
    // `repr` always has an entry for every scored id (set in the same loop).
    const hit = repr.get(externalId) as SearchHit;
    return { ...hit, rrfScore };
  });

  fused.sort((a, b) =>
    b.rrfScore !== a.rrfScore ? b.rrfScore - a.rrfScore : a.externalId.localeCompare(b.externalId),
  );

  return options.limit !== undefined ? fused.slice(0, options.limit) : fused;
}
