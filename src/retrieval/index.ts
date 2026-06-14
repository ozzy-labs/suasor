/**
 * Retrieval module: FTS-first search service + optional embedding/recall
 * enhancement (ADR-0005 / ADR-0006, docs/design/retrieval.md).
 */

export {
  createEmbedder,
  DEFAULT_RECALL_LIMIT,
  deleteSourceVector,
  EMBEDDING_DISABLED_SIGNAL,
  type Embedder,
  EmbeddingError,
  embedSources,
  type FetchLike,
  OllamaEmbedder,
  type OllamaEmbedderOptions,
  type RecallOptions,
  type RecallReason,
  type RecallResult,
  recallSearch,
  toVectorBlob,
  upsertSourceVector,
} from "./embedding/index.ts";
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
