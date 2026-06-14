/** Retrieval module: FTS-first search service (ADR-0005, docs/design/retrieval.md). */
export {
  buildFtsMatch,
  DEFAULT_SEARCH_LIMIT,
  type SearchHit,
  type SearchOptions,
  type SearchResult,
  type SearchStrategy,
  searchSources,
  TRIGRAM_LENGTH,
} from "./search.ts";
