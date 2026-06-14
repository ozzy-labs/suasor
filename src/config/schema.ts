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

/**
 * `[embedding]` — optional sidecar (ADR-0005/0006). Default disabled so the
 * base install stays light. Later Issues extend backend-specific fields.
 */
export const EmbeddingConfig = z
  .object({
    backend: EmbeddingBackend.default("disabled"),
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
  connectors: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
});
export type Config = z.infer<typeof Config>;
