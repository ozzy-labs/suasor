/**
 * Effective-config warnings: keys that are *accepted* by the schema but whose
 * effect is silently dropped at runtime (ADR-0007 silent-error eradication).
 *
 * The schema (`schema.ts`) is deliberately lenient: it accepts a wider enum than
 * the runtime always honors, so a config written today does not break when a
 * backend lands later. The trade-off is that an operator can set a value that
 * looks honored but is not — e.g. `embedding.backend = "openai"` parses cleanly
 * yet, with no API key resolved, `createEmbedder` returns `null` (recall degrades
 * to FTS). That gap is exactly the "configurable but quietly disabled" footgun.
 * The retired `[llm]` section is the same footgun taken to its conclusion — it
 * was never read by anything — so its presence is reported as something to
 * delete rather than as a setting that did not take effect.
 *
 * This module surfaces those gaps as **warnings** (not errors): the degrade
 * behavior is intentional and kept as-is, but the operator is told their setting
 * is not doing what it looks like. `doctor` and the MCP server boot both render
 * these through their existing warn paths so the warning is visible whether the
 * operator runs a health check or just starts the server.
 */
import { docsUrl } from "../shared/doc-ref.ts";
import { collectSidecarEndpoints } from "./sidecar-egress.ts";

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
  embedding: { backend: string; baseUrl?: string; allowRemote?: boolean };
  /** `[llm]` — retired; its mere presence is warned about (ADR-0006 決定 4). */
  llm?: Record<string, unknown>;
  /** `[extraction]` — inspected for a remote (non-loopback) sidecar disclosure. */
  extraction?: { backend: string; baseUrl?: string; allowRemote?: boolean };
  /** `[export]` — its `.composition` sidecar is inspected for a remote disclosure. */
  export?: { composition?: { backend?: string; baseUrl?: string; allowRemote?: boolean } };
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
 * - `[llm]` present at all: the section is retired and read by nothing. Suasor
 *   never calls an LLM — the host is the LLM (ADR-0004 / ADR-0006 決定 4) — so
 *   the fix is to delete the section, not to change its value.
 * - a **remote (non-loopback) content-egressing sidecar** (`[export].composition`
 *   pandoc / `[extraction]` markitdown / `[embedding]` ollama) with a non-loopback
 *   `baseUrl`: the loader only admits these when `<section>.allowRemote = true`
 *   (Issue #436), so reaching runtime means the operator opted in — this **discloses**
 *   the ongoing egress (mirroring the external-embedding key-gate: opt-in egress is
 *   always surfaced, never silent — ADR-0003 / ADR-0007).
 *
 * Implemented / inert values produce no warning: `embedding.backend` of
 * `ollama` (built, local) or `disabled` (intended off), an external backend with
 * a key resolved, no `[llm]` section at all, and
 * a loopback sidecar `baseUrl` (local, no egress).
 *
 * @returns warnings in a stable order (embedding, llm, then remote sidecars in
 *   config order); empty when the effective config holds no silently-dropped keys.
 */
export function collectConfigWarnings(config: ConfigWarningInput): ConfigWarning[] {
  const warnings: ConfigWarning[] = [];

  if (UNIMPLEMENTED_EMBEDDING_BACKENDS.has(config.embedding.backend)) {
    warnings.push({
      key: "embedding.backend",
      message:
        `embedding backend "${config.embedding.backend}" is accepted but not implemented; ` +
        `recall falls back to FTS. See ${docsUrl("guide/embedding.md")}.`,
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
        `in the OS keychain); recall falls back to FTS. See ${docsUrl("guide/embedding.md")}.`,
    });
  }

  // `[llm]` is retired (ADR-0006 決定 4). It is `.optional()` with no default, so
  // "defined" means the file actually carries the section — the notice therefore
  // fires only for configs written against the old template, and disappears the
  // moment the operator deletes it. Staying silent instead would leave someone
  // who set `backend = "anthropic"` believing they had configured something.
  if (config.llm !== undefined) {
    warnings.push({
      key: "llm",
      message:
        "[llm] is retired and ignored: Suasor never calls an LLM — the host is the LLM " +
        "(ADR-0004 / ADR-0006). Delete the section from your config. " +
        `See ${docsUrl("design/config.md")}.`,
    });
  }

  // Remote (non-loopback) content-egressing sidecars, opted into via
  // `<section>.allowRemote` (the loader rejects them otherwise, Issue #436).
  // Disclose the ongoing egress so a remote sidecar is never silent (ADR-0003).
  for (const ep of collectSidecarEndpoints(config)) {
    if (ep.loopback) continue;
    warnings.push({
      key: `${ep.section}.baseUrl`,
      message:
        `${ep.section} sidecar "${ep.baseUrl}" is a remote (non-loopback) endpoint ` +
        `(${ep.allowRemoteKey} = true); ${ep.content} is sent there (egress, ADR-0003). ` +
        "See docs/design/config.md.",
    });
  }

  return warnings;
}
