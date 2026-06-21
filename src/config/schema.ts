/**
 * Config schema (Zod).
 *
 * Minimal foundation config per docs/design/config.md. Each feature Issue
 * (#7–#12) extends its own section. Precedence is enforced by the loader
 * (`init args > env > file > defaults`); see ./loader.ts.
 *
 * Invariants:
 * - Invalid values fail fast as `ConfigError` (NFR-QLT-1, docs/design/config.md).
 * - The `[storage]` section is finalized here; embedding/llm/connectors are
 *   placeholders extended by later Issues (kept lenient via `.passthrough()`).
 */
import { z } from "zod";

/** `[storage]` — local private memory store (ADR-0003). */
export const StorageConfig = z.object({
  /**
   * Path to the SQLite database file. `null` selects the default location
   * (`<configDir>/suasor.db`), resolved by the loader so the default can
   * depend on `SUASOR_CONFIG_DIR`.
   */
  dbPath: z.string().min(1).nullable().default(null),
});
export type StorageConfig = z.infer<typeof StorageConfig>;

/** Backends that never run heavy ML in-process (ADR-0006). */
export const EmbeddingBackend = z.enum(["disabled", "ollama", "openai", "voyage"]);
export type EmbeddingBackend = z.infer<typeof EmbeddingBackend>;

export const LlmBackend = z.enum(["disabled", "anthropic", "openai", "ollama"]);
export type LlmBackend = z.infer<typeof LlmBackend>;

/** Document-extraction backends (ADR-0024). `markitdown` is the implemented sidecar. */
export const ExtractionBackend = z.enum(["disabled", "markitdown"]);
export type ExtractionBackend = z.infer<typeof ExtractionBackend>;

/** Document-composition backends (#138, md→Office). `pandoc` is the implemented sidecar. */
export const CompositionBackend = z.enum(["disabled", "pandoc"]);
export type CompositionBackend = z.infer<typeof CompositionBackend>;

/** Default Ollama sidecar base URL (`/api/embed` is appended by the client). */
export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
/** Default multilingual embedding model (JA↔EN, 1024-dim) for Ollama. */
export const DEFAULT_OLLAMA_MODEL = "bge-m3";
/**
 * Default embedding vector dimension (bge-m3 = 1024). Sizes the vec0 table; must
 * agree with the runtime fallback `DEFAULT_EMBEDDING_DIM` in src/db/connection.ts.
 */
const DEFAULT_EMBEDDING_DIM = 1024;

/** Default markitdown extraction sidecar base URL (`/extract` appended by the client). */
export const DEFAULT_MARKITDOWN_BASE_URL = "http://localhost:8929";
/** Default cap on extracted text bytes (ADR-0024 §5; large PDFs degrade to name-only). */
const DEFAULT_EXTRACTION_MAX_BYTES = 5_000_000;

/** Default pandoc composition sidecar base URL (`/compose` appended by the client). */
export const DEFAULT_PANDOC_BASE_URL = "http://localhost:8930";

/**
 * `[embedding]` — optional sidecar/API (ADR-0005/0006). Default disabled so the
 * base install stays light; ML is always delegated to a sidecar/API (no
 * in-process torch). `model` pins the embedding model so that document
 * embeddings (ingest) and query embeddings (recall) share one vector space —
 * mixing models silently degrades recall, so the same `model` value drives both.
 *
 * Three backends are implemented: `ollama` (local sidecar, egress-free, the
 * default `baseUrl`/`model` below), and the external `openai` / `voyage` APIs.
 * The external backends **egress body text** to a remote API (ADR-0003), so they
 * are opt-in and gated on an API key resolved from the OS keychain / env (never
 * config — see src/connectors/secrets.ts `resolveEmbeddingApiKey`); without a key
 * recall degrades to FTS. When using an external backend, set `baseUrl` / `model`
 * / `dim` for that provider (e.g. openai `text-embedding-3-small` = 1536-dim;
 * voyage `voyage-3` = 1024-dim) — see docs/guide/embedding.md.
 *
 * Unknown keys are preserved (`passthrough`) for backend-specific options not yet
 * modeled. The defaults below target the Ollama backend.
 */
export const EmbeddingConfig = z
  .object({
    backend: EmbeddingBackend.default("disabled"),
    /**
     * API/sidecar base URL. Ollama: `/api/embed` is appended (default below).
     * openai/voyage: `/v1/embeddings` is appended — set the provider host
     * (`https://api.openai.com` / `https://api.voyageai.com`).
     */
    baseUrl: z.string().url().default(DEFAULT_OLLAMA_BASE_URL),
    /** Embedding model name. Must be identical for ingest and query (one space). */
    model: z.string().min(1).default(DEFAULT_OLLAMA_MODEL),
    /**
     * Embedding vector dimension — must match what `model` produces (bge-m3 =
     * 1024; e.g. nomic-embed-text = 768). It sizes the vec0 table when the DB is
     * first created, so changing it on an existing store needs a fresh DB (or a
     * delete + rebuild + re-sync). A value that disagrees with the model makes
     * every vector insert fail, silently degrading recall to empty — set this
     * whenever `model` is not a 1024-dim model.
     */
    dim: z.number().int().positive().default(DEFAULT_EMBEDDING_DIM),
  })
  .passthrough();
export type EmbeddingConfig = z.infer<typeof EmbeddingConfig>;

/** `[llm]` — optional delegation target (ADR-0006). */
export const LlmConfig = z
  .object({
    backend: LlmBackend.default("disabled"),
  })
  .passthrough();
export type LlmConfig = z.infer<typeof LlmConfig>;

/**
 * `[extraction]` — optional document-extraction sidecar (ADR-0024). Default
 * disabled so the base install stays light; Office/PDF bodies stay name-only
 * until a sidecar is configured. ML is delegated to a sidecar (markitdown-style,
 * ADR-0006) — no in-process parsers. `maxBytes` caps extracted text so a large
 * PDF cannot bloat the store/FTS (oversized → name-only fallback). Unknown keys
 * are preserved (`passthrough`) for backend-specific options not yet modeled.
 */
export const ExtractionConfig = z
  .object({
    backend: ExtractionBackend.default("disabled"),
    /** Sidecar base URL (markitdown). `/extract` is appended by the client. */
    baseUrl: z.string().url().default(DEFAULT_MARKITDOWN_BASE_URL),
    /** Max extracted-text bytes; larger inputs degrade to name-only. */
    maxBytes: z.number().int().positive().default(DEFAULT_EXTRACTION_MAX_BYTES),
    /**
     * Extractor version tag (ADR-0024 §6). Recorded per source in
     * `extraction_meta`; bump it after upgrading the sidecar to re-extract drifted
     * sources on the next sync. Newly enabling extraction also drifts (no prior
     * meta), so existing name-only files backfill automatically.
     */
    version: z.string().min(1).default("1"),
  })
  .passthrough();
export type ExtractionConfig = z.infer<typeof ExtractionConfig>;

/**
 * `[export]` — local draft export (ADR-0025). `draft.export` writes drafts as
 * files **under `dir` only** (sandbox; no egress, no source write-back). `dir`
 * defaults to `<configDir>/exports/` (resolved in the loader, like
 * `[storage].dbPath`). It must NOT sit under a `[connectors.local].roots` entry,
 * or exported drafts would be re-ingested (the loader/tool guards this).
 */
export const ExportConfig = z
  .object({
    /** Export sandbox directory (absolute). `null` → `<configDir>/exports/`. */
    dir: z.string().min(1).nullable().default(null),
    /**
     * Office-format composition sidecar (#138, md→docx/pptx/xlsx). Default
     * disabled: `draft.export` then only supports `md`/`txt` (no heavy converter).
     * `pandoc` is the implemented backend (md→Office via a pandoc-style sidecar,
     * ADR-0006 ML delegation). md/txt never need it.
     */
    composition: z
      .object({
        backend: CompositionBackend.default("disabled"),
        /** Sidecar base URL (pandoc). `/compose` is appended by the client. */
        baseUrl: z.string().url().default(DEFAULT_PANDOC_BASE_URL),
      })
      .passthrough()
      .default(() => ({ backend: "disabled" as const, baseUrl: DEFAULT_PANDOC_BASE_URL })),
  })
  .passthrough();
export type ExportConfig = z.infer<typeof ExportConfig>;

/**
 * Root config. `connectors` is an open record extended per-connector by
 * #7–#12; values are left lenient at the foundation layer.
 *
 * Section defaults are produced by parsing `{}` through each section schema so
 * the section's *own* field defaults (e.g. `backend = "disabled"`) propagate
 * when the section is omitted entirely — Zod does not re-parse a literal
 * `.default({})` value.
 */
export const Config = z.object({
  storage: StorageConfig.default(() => StorageConfig.parse({})),
  embedding: EmbeddingConfig.default(() => EmbeddingConfig.parse({})),
  llm: LlmConfig.default(() => LlmConfig.parse({})),
  extraction: ExtractionConfig.default(() => ExtractionConfig.parse({})),
  export: ExportConfig.default(() => ExportConfig.parse({})),
  connectors: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
});
export type Config = z.infer<typeof Config>;
