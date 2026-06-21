/**
 * Document-extraction module (ADR-0024).
 *
 * Import-clean: re-exports the thin extractor client (sidecar — no in-process
 * parsing, ADR-0006). The connector sync pipeline builds an `Extractor` via
 * `createExtractor` and converts Office/PDF bodies to text. The shared extraction
 * stage is connector-agnostic: `local` (FS) and `box` (API content fetch) drive
 * it via the same `extractable` handle (#241); Drive / OneDrive extend it next.
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
  EXTRACTABLE_SOURCE_TYPES,
  type ExtractionStatus,
  extractionStatus,
  listPendingExtractions,
  type PendingExtraction,
} from "./maintenance.ts";
