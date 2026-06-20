/**
 * Document-extraction module (ADR-0024).
 *
 * Import-clean: re-exports the thin extractor client (sidecar — no in-process
 * parsing, ADR-0006). The connector sync pipeline builds an `Extractor` via
 * `createExtractor` and converts Office/PDF bodies to text (local-first scope).
 */
export {
  createExtractor,
  ExtractionError,
  type Extractor,
  type FetchLike,
  MarkitdownExtractor,
  type MarkitdownExtractorOptions,
} from "./extractor.ts";
