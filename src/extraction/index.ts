/**
 * Document-extraction module (ADR-0024).
 *
 * Import-clean: re-exports the thin extractor client (sidecar — no in-process
 * parsing, ADR-0006). The connector sync pipeline builds an `Extractor` via
 * `createExtractor` and converts Office/PDF bodies to text (local-first scope).
 */
export {
  createExtractor,
  EXTRACTABLE_EXTENSIONS,
  ExtractionError,
  type Extractor,
  type FetchLike,
  MarkitdownExtractor,
  type MarkitdownExtractorOptions,
} from "./extractor.ts";
export {
  type ExtractionStatus,
  extractionStatus,
  listPendingExtractions,
  type PendingExtraction,
} from "./maintenance.ts";
