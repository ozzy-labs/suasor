/**
 * MCP server surface — the agent boundary (ADR-0004, docs/design/mcp-surface.md).
 *
 * Exposes Suasor's read tools over MCP using the official TypeScript SDK. The
 * read half: `search` (FTS5), `recall.search` (semantic vec0 KNN when an
 * embedding backend is enabled, else the `embedding_disabled` signal — #11),
 * `source.list` / `source.get`, and `task.list` / `decision.list` /
 * `inbox.list`. The first write tool, `connector.sync` (read-only ingest into
 * the local store), is registered when a writable `Store` + config are supplied
 * (ADR-0007 / Issue #10 D5); the remaining write tools (`propose.*`,
 * `task.create`) land in later Issues. Write tools carry `readOnlyHint: false`
 * so hosts gate them behind HITL (no auto-apply, ADR-0004).
 *
 * Read = no side effects: every read tool only SELECTs (queries.ts) or runs the
 * FTS-first / recall search services (retrieval/), and is annotated
 * `readOnlyHint: true` so MCP hosts may auto-approve them. recall embeds the
 * query via a sidecar/API client (ADR-0006) but performs no store mutation. The
 * split is structural, not advisory.
 */
import type { Database } from "bun:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_MODEL,
  type EmbeddingConfig,
} from "../config/schema.ts";
import { runConnectorSyncTool } from "../connectors/mcp-tool.ts";
import type { Store } from "../db/index.ts";
import {
  createEmbedder,
  DEFAULT_RECALL_LIMIT,
  EMBEDDING_DISABLED_SIGNAL,
  type Embedder,
  EmbeddingError,
  recallSearch,
} from "../retrieval/embedding/index.ts";
import { DEFAULT_SEARCH_LIMIT, searchSources } from "../retrieval/search.ts";
import { VERSION } from "../version.ts";
import {
  DEFAULT_LIST_LIMIT,
  getSource,
  listDecisions,
  listInbox,
  listSources,
  listTasks,
} from "./queries.ts";

export { EMBEDDING_DISABLED_SIGNAL };

/** Bounds for the `limit` argument shared across list tools. */
const MAX_LIMIT = 500;

/** ISO 8601 datetime string (with offset), as stored on every projection. */
const isoDateTime = z.iso.datetime({ offset: true });

/** Reusable `limit` shape: positive integer, capped. */
const limitShape = z.number().int().positive().max(MAX_LIMIT).optional();

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
  embedding: Pick<EmbeddingConfig, "backend" | "baseUrl" | "model"> | EmbeddingConfig["backend"];
  /**
   * Pre-built embedder override (tests inject a fake to avoid a live sidecar).
   * When provided it takes precedence over building one from `embedding`.
   */
  embedder?: Embedder | null;
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
    };
  };
}

/** Normalize the `embedding` dep (bare backend string or full config) → config. */
function resolveEmbeddingConfig(
  embedding: McpServerDeps["embedding"],
): Pick<EmbeddingConfig, "backend" | "baseUrl" | "model"> {
  if (typeof embedding === "string") {
    // Back-compat: a bare backend string uses the schema model/baseUrl defaults.
    return { backend: embedding, baseUrl: DEFAULT_OLLAMA_BASE_URL, model: DEFAULT_OLLAMA_MODEL };
  }
  return embedding;
}

/** Wrap a JSON-serializable value as an MCP text content result. */
function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

/**
 * Build the Suasor MCP server with the read tools registered. The caller is
 * responsible for connecting a transport (`server.connect(transport)`).
 */
export function buildMcpServer(deps: McpServerDeps): McpServer {
  const { sqlite, write } = deps;
  const embeddingConfig = resolveEmbeddingConfig(deps.embedding);
  // An injected embedder (tests) wins; otherwise build one from config. `null`
  // means no backend (or an unimplemented one) → recall degrades to FTS.
  const embedder = deps.embedder !== undefined ? deps.embedder : createEmbedder(embeddingConfig);
  const server = new McpServer(
    { name: "suasor", version: VERSION },
    {
      instructions:
        "Suasor read surface: local-first work memory (ADR-0004). All tools here " +
        "are read-only and safe to call autonomously. Default retrieval is `search` " +
        "(FTS5); `recall.search` adds semantic search only when an embedding backend " +
        "is enabled, otherwise it returns the `embedding_disabled` signal so you can " +
        "fall back to `search`. Write/HITL tools are exposed separately.",
    },
  );

  // --- search: FTS-first full-text search (ADR-0005, the default path). ---
  server.registerTool(
    "search",
    {
      title: "Search",
      description:
        "Full-text search over ingested source bodies (SQLite FTS5, FTS-first). " +
        "Handles Japanese and English uniformly; short queries fall back to a " +
        "substring scan. Returns ranked hits best-first.",
      inputSchema: {
        query: z.string().min(1).describe("Free-text query."),
        limit: limitShape.describe(`Max hits (default ${DEFAULT_SEARCH_LIMIT}).`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit }) => {
      const result = searchSources(sqlite, query, { limit: limit ?? DEFAULT_SEARCH_LIMIT });
      return jsonResult(result);
    },
  );

  // --- recall.search: semantic (embedding) search, graceful-degraded. ---
  server.registerTool(
    "recall.search",
    {
      title: "Recall (semantic search)",
      description:
        "Semantic (embedding) search over ingested sources (vec0 KNN). Crosses the " +
        "wall FTS cannot (JA↔EN, vocabulary mismatch). When no embedding backend is " +
        "enabled — or the sidecar is unreachable — it returns empty results with an " +
        "`embedding_disabled` signal so the host can fall back to `search` (ADR-0005).",
      inputSchema: {
        query: z.string().min(1).describe("Free-text query."),
        limit: limitShape.describe(`Max hits (default ${DEFAULT_RECALL_LIMIT}).`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit }) => {
      // No embedder (backend disabled or unimplemented) → embedding_disabled.
      if (embedder === null) {
        return jsonResult({
          hits: [],
          signal: EMBEDDING_DISABLED_SIGNAL,
          reason: "backend_disabled",
        });
      }
      try {
        const result = await recallSearch(sqlite, embedder, query, {
          limit: limit ?? DEFAULT_RECALL_LIMIT,
        });
        return jsonResult(result);
      } catch (error) {
        // A sidecar failure (Ollama down, etc.) must NOT hard-error: degrade to
        // the same signal so the host keeps working via FTS `search` (ADR-0005).
        if (error instanceof EmbeddingError) {
          return jsonResult({
            hits: [],
            signal: EMBEDDING_DISABLED_SIGNAL,
            reason: "backend_unreachable",
          });
        }
        throw error;
      }
    },
  );

  // --- source.list / source.get ---
  server.registerTool(
    "source.list",
    {
      title: "List sources",
      description:
        "List ingested sources newest-first (by observed_at), optionally filtered " +
        "by source_type and an observed_after/observed_before time window.",
      inputSchema: {
        sourceType: z.string().min(1).optional().describe("Filter by source_type."),
        observedAfter: isoDateTime.optional().describe("Inclusive lower bound on observed_at."),
        observedBefore: isoDateTime.optional().describe("Exclusive upper bound on observed_at."),
        limit: limitShape.describe(`Max rows (default ${DEFAULT_LIST_LIMIT}).`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ sourceType, observedAfter, observedBefore, limit }) => {
      const sources = listSources(sqlite, {
        sourceType,
        observed: { after: observedAfter, before: observedBefore },
        limit,
      });
      return jsonResult({ sources });
    },
  );

  server.registerTool(
    "source.get",
    {
      title: "Get source",
      description: "Fetch a single ingested source (including its body) by external_id.",
      inputSchema: {
        externalId: z.string().min(1).describe("Connector-assigned source id."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ externalId }) => {
      const source = getSource(sqlite, externalId);
      return jsonResult({ source });
    },
  );

  // --- task.list ---
  server.registerTool(
    "task.list",
    {
      title: "List tasks",
      description:
        "List tasks most-recently-updated first, optionally filtered by state and " +
        "an updated_after/updated_before time window.",
      inputSchema: {
        state: z.string().min(1).optional().describe("Filter by lifecycle state."),
        updatedAfter: isoDateTime.optional().describe("Inclusive lower bound on updated_at."),
        updatedBefore: isoDateTime.optional().describe("Exclusive upper bound on updated_at."),
        limit: limitShape.describe(`Max rows (default ${DEFAULT_LIST_LIMIT}).`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ state, updatedAfter, updatedBefore, limit }) => {
      const tasks = listTasks(sqlite, {
        state,
        updated: { after: updatedAfter, before: updatedBefore },
        limit,
      });
      return jsonResult({ tasks });
    },
  );

  // --- decision.list ---
  server.registerTool(
    "decision.list",
    {
      title: "List decisions",
      description:
        "List recorded decisions most-recently-recorded first, optionally filtered " +
        "by a recorded_after/recorded_before time window.",
      inputSchema: {
        recordedAfter: isoDateTime.optional().describe("Inclusive lower bound on recorded_at."),
        recordedBefore: isoDateTime.optional().describe("Exclusive upper bound on recorded_at."),
        limit: limitShape.describe(`Max rows (default ${DEFAULT_LIST_LIMIT}).`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ recordedAfter, recordedBefore, limit }) => {
      const decisions = listDecisions(sqlite, {
        recorded: { after: recordedAfter, before: recordedBefore },
        limit,
      });
      return jsonResult({ decisions });
    },
  );

  // --- inbox.list ---
  server.registerTool(
    "inbox.list",
    {
      title: "List inbox items",
      description:
        "List inbox items most-recently-updated first, optionally filtered by state " +
        "and an updated_after/updated_before time window.",
      inputSchema: {
        state: z.string().min(1).optional().describe("Filter by triage state."),
        updatedAfter: isoDateTime.optional().describe("Inclusive lower bound on updated_at."),
        updatedBefore: isoDateTime.optional().describe("Exclusive upper bound on updated_at."),
        limit: limitShape.describe(`Max rows (default ${DEFAULT_LIST_LIMIT}).`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ state, updatedAfter, updatedBefore, limit }) => {
      const items = listInbox(sqlite, {
        state,
        updated: { after: updatedAfter, before: updatedBefore },
        limit,
      });
      return jsonResult({ items });
    },
  );

  // --- connector.sync: read-only ingest into the local store (WRITE / HITL). ---
  // Registered only when a writable store is supplied. `readOnlyHint: false`
  // marks it as a write tool so hosts gate it behind human approval (ADR-0004);
  // it calls the same `syncConnector` service as the `suasor <connector> sync`
  // CLI (Issue #10 D5).
  if (write) {
    server.registerTool(
      "connector.sync",
      {
        title: "Connector sync (ingest)",
        description:
          "Run a read-only connector ingest pass into the local store (e.g. " +
          "github). Write tool: requires human approval — no auto-apply. Incremental " +
          "via fingerprint/cursor delta; pass cursor=null to force a full re-scan.",
        inputSchema: {
          connector: z.string().min(1).describe('Connector to run (e.g. "github").'),
          cursor: z
            .string()
            .nullable()
            .optional()
            .describe("Resume cursor; omit to resume, null to re-scan fully."),
        },
        annotations: { readOnlyHint: false, openWorldHint: true },
      },
      async ({ connector, cursor }) => {
        const outcome = await runConnectorSyncTool(
          { connector, ...(cursor !== undefined ? { cursor } : {}) },
          { store: write.store, config: write.config },
        );
        return jsonResult(outcome);
      },
    );
  }

  return server;
}
