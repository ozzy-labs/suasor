/**
 * Embedding module: optional semantic-search enhancement over FTS-first
 * retrieval (ADR-0005 / ADR-0006, docs/design/retrieval.md).
 *
 * Import-clean: re-exports the thin embedder client (sidecar/API — no in-process
 * ML) and the recall/vec0 maintenance helpers. Network calls happen only when an
 * `Embedder` is actually used (created from config); a `disabled` backend yields
 * a `null` embedder and recall degrades to the `embedding_disabled` signal.
 */
export {
  createEmbedder,
  createEmbedderResolved,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_VOYAGE_BASE_URL,
  DEFAULT_VOYAGE_MODEL,
  DimensionCheckedEmbedder,
  type Embedder,
  type EmbedderRobustnessOptions,
  EmbeddingError,
  EXTERNAL_EMBEDDING_BACKENDS,
  type FetchLike,
  OllamaEmbedder,
  type OllamaEmbedderOptions,
  type OpenAICompatibleEmbedderOptions,
  OpenAIEmbedder,
  resolveEmbeddingApiKeyPresent,
  VoyageEmbedder,
} from "./embedder.ts";
export {
  DEFAULT_DUPLICATE_THRESHOLD,
  type DuplicatePair,
  type EmbeddingKindStatus,
  type EmbeddingRebuildResult,
  type EmbeddingStatus,
  embeddingDrain,
  embeddingRebuild,
  embeddingStatus,
  type FailedEmbedding,
  findDuplicates,
  listFailedEmbeddings,
} from "./maintenance.ts";
export {
  DEFAULT_RECALL_LIMIT,
  EMBEDDING_DISABLED_SIGNAL,
  embedSources,
  RECALL_FILTER_OVERFETCH,
  type RecallOptions,
  type RecallReason,
  type RecallResult,
  recallSearch,
  toVectorBlob,
  upsertSourceVector,
  type VectorProvenance,
} from "./recall.ts";
