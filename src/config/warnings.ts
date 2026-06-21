/**
 * Effective-config warnings: keys that are *accepted* by the schema but whose
 * effect is silently dropped at runtime (ADR-0007 silent-error eradication).
 *
 * The schema (`schema.ts`) is deliberately lenient: it accepts a wider enum than
 * the runtime always honors, so a config written today does not break when a
 * backend lands later. The trade-off is that an operator can set a value that
 * looks honored but is not — e.g. `embedding.backend = "openai"` parses cleanly
 * yet, with no API key resolved, `createEmbedder` returns `null` (recall degrades
 * to FTS); and `[llm].backend` parses yet nothing in the runtime ever reads it
 * (ML is delegated to the host LLM per ADR-0006). That gap is exactly the
 * "configurable but quietly disabled" footgun.
 *
 * This module surfaces those gaps as **warnings** (not errors): the degrade
 * behavior is intentional and kept as-is, but the operator is told their setting
 * is not doing what it looks like. `doctor` and the MCP server boot both render
 * these through their existing warn paths so the warning is visible whether the
 * operator runs a health check or just starts the server.
 */

/** A single "accepted but not honored" config finding. */
export interface ConfigWarning {
  /** The config key whose value is silently dropped (e.g. `embedding.backend`). */
  key: string;
  /** Human-readable explanation of what is dropped and the effective behavior. */
  message: string;
}

/**
 * Embedding backends the schema accepts but `createEmbedder` does not implement.
 * Empty now that `ollama` / `openai` / `voyage` are all built; kept as the seam
 * for any future schema-accepted-but-unbuilt backend.
 */
const UNIMPLEMENTED_EMBEDDING_BACKENDS = new Set<string>();

/** External embedding backends that egress body text and require an API key. */
const EXTERNAL_EMBEDDING_BACKENDS = new Set(["openai", "voyage"]);

/**
 * Subset of {@link import("./schema.ts").Config} the warning check inspects.
 * Structural (not the full schema) so callers can pass a resolved `Config` and
 * tests a minimal literal without depending on every section.
 *
 * `embeddingApiKeyPresent` carries the result of resolving the external backend's
 * API key (keychain/env). Callers do that async lookup and pass the boolean so
 * this check stays synchronous. It is only consulted for external backends
 * (openai/voyage); leave it `undefined` for ollama/disabled (the readiness
 * branch is skipped for those anyway).
 */
export interface ConfigWarningInput {
  embedding: { backend: string };
  llm: { backend: string };
  embeddingApiKeyPresent?: boolean;
}

/**
 * Collect warnings for config keys that are accepted but silently not honored.
 *
 * - `embedding.backend` unbuilt (none today): schema-accepted but no embedder is
 *   built, so recall falls back to FTS. (Reserved seam — currently inert.)
 * - `embedding.backend = openai | voyage` with **no API key resolved**: the
 *   backend is implemented but the egress (ADR-0003) is gated on a key from the
 *   keychain/env, never config. Without one no embedder is built and recall
 *   degrades to FTS — surfaced as a readiness warning so the operator knows to
 *   set the key. With a key present this is silent (the backend works).
 * - `[llm].backend != disabled`: schema-accepted but never read by the runtime —
 *   inference is delegated to the host LLM (ADR-0006 ML delegation), so the
 *   setting has no effect today.
 *
 * Implemented / inert values produce no warning: `embedding.backend` of
 * `ollama` (built, local) or `disabled` (intended off), an external backend with
 * a key resolved, and `[llm].backend = disabled` (the default, nothing dropped).
 *
 * @returns warnings in a stable order (embedding before llm); empty when the
 *   effective config holds no silently-dropped keys.
 */
export function collectConfigWarnings(config: ConfigWarningInput): ConfigWarning[] {
  const warnings: ConfigWarning[] = [];

  if (UNIMPLEMENTED_EMBEDDING_BACKENDS.has(config.embedding.backend)) {
    warnings.push({
      key: "embedding.backend",
      message:
        `embedding backend "${config.embedding.backend}" is accepted but not implemented; ` +
        "recall falls back to FTS. See docs/guide/embedding.md.",
    });
  } else if (
    EXTERNAL_EMBEDDING_BACKENDS.has(config.embedding.backend) &&
    config.embeddingApiKeyPresent !== true
  ) {
    warnings.push({
      key: "embedding.backend",
      message:
        `embedding backend "${config.embedding.backend}" is set but no API key is configured ` +
        `(set SUASOR_EMBEDDING_${config.embedding.backend.toUpperCase()}_API_KEY or store it ` +
        "in the OS keychain); recall falls back to FTS. See docs/guide/embedding.md.",
    });
  }

  if (config.llm.backend !== "disabled") {
    warnings.push({
      key: "llm.backend",
      message:
        `[llm] backend "${config.llm.backend}" is set but unused at runtime ` +
        "(inference is delegated to the host LLM, ADR-0006); the setting has no effect. " +
        "See docs/design/config.md.",
    });
  }

  return warnings;
}
