/**
 * Shared building blocks for the MCP server surface (ADR-0004), extracted from
 * the former monolithic `server.ts` so the read-tool and write-tool halves can
 * live in focused modules (`server-read.ts` / `server-write.ts`). Behaviour is
 * unchanged: this only relocates the deps contract, the Zod shape constants, and
 * the small result/embedding helpers all three modules share.
 */

import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_MODEL,
  type EmbeddingConfig,
  type ExportConfig,
  type ExtractionConfig,
} from "../config/schema.ts";
import type { Store } from "../db/index.ts";
import type { Embedder } from "../retrieval/embedding/index.ts";

/** Bounds for the `limit` argument shared across list tools. */
export const MAX_LIMIT = 500;

/** ISO 8601 datetime string (with offset), as stored on every projection. */
export const isoDateTime = z.iso.datetime({ offset: true });

/** Reusable `limit` shape: positive integer, capped. */
export const limitShape = z.number().int().positive().max(MAX_LIMIT).optional();

/** Inputs needed to build the tool surface. */
export interface McpServerDeps {
  /** Open projection/FTS database handle (read tools use this directly). */
  sqlite: Database;
  /**
   * Effective `[embedding]` config. When `backend !== "disabled"` (and the
   * backend is implemented), `recall.search` runs real vec0 semantic search
   * with the configured model; otherwise it returns the `embedding_disabled`
   * signal so the host falls back to FTS `search` (ADR-0005 graceful degrade).
   *
   * Accepts either the full config (preferred) or a bare backend string for
   * back-compat; a bare string with no model uses the schema defaults.
   */
  embedding:
    | (Pick<EmbeddingConfig, "backend" | "baseUrl" | "model"> &
        Partial<Pick<EmbeddingConfig, "dim" | "maxBatch" | "requestTimeoutMs" | "maxRetries">>)
    | EmbeddingConfig["backend"];
  /**
   * Pre-built embedder override (tests inject a fake to avoid a live sidecar).
   * When provided it takes precedence over building one from `embedding`.
   */
  embedder?: Embedder | null;
  /**
   * Operator Slack user ids for `slack.demand.list` `<@you>` mention detection
   * (ADR-0012), resolved from `[connectors.slack]` config. Empty/omitted →
   * demand falls back to DM-only unless the caller passes `selfUserId`.
   */
  slackSelfUserIds?: string[];
  /**
   * Whether the Slack connector is configured at all (`[connectors.slack]`
   * present), independent of whether a `self_user_id` is set (Issue #189). Drives
   * the `brief` completeness signal `slack_not_configured` so the host can tell
   * "Slack not connected → demand always empty" from "genuinely quiet". Omitted
   * defaults to `slackSelfUserIds.length > 0` for back-compat.
   */
  slackConfigured?: boolean;
  /**
   * Writable store + connector config for the `connector.sync` write tool
   * (ADR-0007 / Issue #10). When omitted, the server exposes read tools only
   * (e.g. a read-only deployment); the write tool is simply not registered.
   */
  write?: {
    /** Store the (HITL-approved) ingest writes through. */
    store: Store;
    /**
     * Effective config, providing each `[connectors.<name>]` slice plus the
     * `[embedding]` section so ingest can (re)populate vec0 (ADR-0005/0006).
     */
    config: {
      connectors: Record<string, Record<string, unknown>>;
      embedding?: Pick<EmbeddingConfig, "backend" | "baseUrl" | "model">;
      /** `[extraction]` section; enables Office/PDF body extraction at ingest (ADR-0024). */
      extraction?: Pick<ExtractionConfig, "backend" | "baseUrl" | "maxBytes">;
      /** `[export]` section; `draft.export` writes into `dir` (ADR-0025) + composition (#138). */
      export?: Pick<ExportConfig, "dir" | "composition">;
    };
  };
}

/** Normalize the `embedding` dep (bare backend string or full config) → config. */
export function resolveEmbeddingConfig(
  embedding: McpServerDeps["embedding"],
): Exclude<McpServerDeps["embedding"], string> {
  if (typeof embedding === "string") {
    // Back-compat: a bare backend string uses the schema model/baseUrl defaults.
    return { backend: embedding, baseUrl: DEFAULT_OLLAMA_BASE_URL, model: DEFAULT_OLLAMA_MODEL };
  }
  return embedding;
}

/** Wrap a JSON-serializable value as an MCP text content result. */
export function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}
