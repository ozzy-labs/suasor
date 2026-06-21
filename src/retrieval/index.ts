/**
 * Retrieval module: FTS-first search service + optional embedding/recall
 * enhancement (ADR-0005 / ADR-0006, docs/design/retrieval.md).
 */

export {
  createEmbedder,
  createEmbedderResolved,
  DEFAULT_DUPLICATE_THRESHOLD,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_RECALL_LIMIT,
  DEFAULT_VOYAGE_BASE_URL,
  DEFAULT_VOYAGE_MODEL,
  type DuplicatePair,
  EMBEDDING_DISABLED_SIGNAL,
  type Embedder,
  EmbeddingError,
  type EmbeddingKindStatus,
  type EmbeddingRebuildResult,
  type EmbeddingStatus,
  EXTERNAL_EMBEDDING_BACKENDS,
  embeddingDrain,
  embeddingRebuild,
  embeddingStatus,
  embedSources,
  type FetchLike,
  findDuplicates,
  OllamaEmbedder,
  type OllamaEmbedderOptions,
  type OpenAICompatibleEmbedderOptions,
  OpenAIEmbedder,
  type RecallOptions,
  type RecallReason,
  type RecallResult,
  recallSearch,
  resolveEmbeddingApiKeyPresent,
  toVectorBlob,
  upsertSourceVector,
  type VectorProvenance,
  VoyageEmbedder,
} from "./embedding/index.ts";
export {
  DEFAULT_RRF_K,
  type FuseOptions,
  fuseRrf,
  type HybridHit,
} from "./hybrid.ts";
export {
  buildFtsMatch,
  DEFAULT_SEARCH_LIMIT,
  type SearchFilters,
  type SearchHit,
  type SearchOptions,
  type SearchResult,
  type SearchStrategy,
  searchSources,
  TRIGRAM_LENGTH,
} from "./search.ts";
