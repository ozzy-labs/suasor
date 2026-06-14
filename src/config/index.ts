/** Config module: Zod schema + layered loader (docs/design/config.md). */
export { ConfigError } from "./error.ts";
export {
  envToLayer,
  type LoadConfigOptions,
  loadConfig,
  resolveConfigDir,
} from "./loader.ts";
export {
  Config,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_MODEL,
  EmbeddingBackend,
  EmbeddingConfig,
  LlmBackend,
  LlmConfig,
  StorageConfig,
} from "./schema.ts";
