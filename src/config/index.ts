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
  EmbeddingBackend,
  EmbeddingConfig,
  LlmBackend,
  LlmConfig,
  StorageConfig,
} from "./schema.ts";
