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
  DEFAULT_DIGEST_LIMIT,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_MODEL,
  DigestChannelName,
  DigestConfig,
  DigestJob,
  EmbeddingBackend,
  EmbeddingConfig,
  LlmConfig,
  StorageConfig,
} from "./schema.ts";
export {
  collectSidecarEndpoints,
  isLoopbackUrl,
  SIDECAR_LOOPBACK_ALLOWLIST,
  type SidecarEgressInput,
  type SidecarEndpoint,
  type SidecarSection,
} from "./sidecar-egress.ts";
export {
  type ConfigWarning,
  type ConfigWarningInput,
  collectConfigWarnings,
} from "./warnings.ts";
