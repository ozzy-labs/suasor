/**
 * MCP server surface — the agent boundary (ADR-0004, docs/design/mcp-surface.md).
 *
 * Exposes Suasor's read tools over MCP using the official TypeScript SDK. The
 * read half: `search`, `recall.search` (graceful-degraded stub until #11),
 * `source.list` / `source.get`, and `task.list` / `decision.list` /
 * `inbox.list`. The write tools — `connector.sync` (read-only ingest, ADR-0007 /
 * #10), `propose.generate` / `propose.apply` (HITL candidate generation +
 * application, #12), and `task.create` (direct task creation, #12 追補 D2) — are
 * registered when a writable `Store` + config are supplied. Write tools carry
 * `readOnlyHint: false` so hosts gate them behind HITL (no auto-apply, ADR-0004 /
 * FR-PRO-2).
 *
 * Read = no side effects: every read tool only SELECTs (queries.ts) or runs the
 * FTS-first search service (retrieval/), and is annotated `readOnlyHint: true`
 * so MCP hosts may auto-approve them. The split is structural, not advisory.
 */
import type { Database } from "bun:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runConnectorSyncTool } from "../connectors/mcp-tool.ts";
import type { Store } from "../db/index.ts";
import { proposeApply } from "../propose/apply.ts";
import {
  CandidateInput as CandidateInputSchema,
  Candidate as CandidateSchema,
  MODE_ALLOWED_KINDS,
  PROPOSE_MODES,
  ProposeMode as ProposeModeSchema,
} from "../propose/candidates.ts";
import { proposeGenerate } from "../propose/generate.ts";
import { taskCreate } from "../propose/task-create.ts";
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

/** Signal returned by `recall.search` when no embedding backend is enabled. */
export const EMBEDDING_DISABLED_SIGNAL = "embedding_disabled";

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
   * Embedding backend from config. `recall.search` returns the
   * `embedding_disabled` signal (empty results) unless this is enabled
   * (full semantic search lands in #11). ADR-0005 graceful degradation.
   */
  embeddingBackend: string;
  /**
   * Writable store + connector config for the `connector.sync` write tool
   * (ADR-0007 / Issue #10). When omitted, the server exposes read tools only
   * (e.g. a read-only deployment); the write tool is simply not registered.
   */
  write?: {
    /** Store the (HITL-approved) ingest writes through. */
    store: Store;
    /** Effective config, providing each `[connectors.<name>]` slice. */
    config: { connectors: Record<string, Record<string, unknown>> };
  };
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
  const { sqlite, embeddingBackend, write } = deps;
  const server = new McpServer(
    { name: "suasor", version: VERSION },
    {
      instructions:
        "Suasor local-first work memory (ADR-0004). Read tools (readOnlyHint: " +
        "true) are safe to call autonomously. Default retrieval is `search` " +
        "(FTS5); `recall.search` adds semantic search only when an embedding backend " +
        "is enabled, otherwise it returns the `embedding_disabled` signal so you can " +
        "fall back to `search`. Write tools (readOnlyHint: false — connector.sync, " +
        "propose.generate, propose.apply, task.create) are HITL: gate them behind " +
        "human approval, never auto-apply.",
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

  // --- recall.search: semantic search; graceful-degraded until #11. ---
  server.registerTool(
    "recall.search",
    {
      title: "Recall (semantic search)",
      description:
        "Semantic (embedding) search. When no embedding backend is enabled it " +
        "returns empty results with an `embedding_disabled` signal so the host can " +
        "fall back to `search` (ADR-0005). Full semantic ranking lands in a later Issue.",
      inputSchema: {
        query: z.string().min(1).describe("Free-text query."),
        limit: limitShape.describe(`Max hits (default ${DEFAULT_SEARCH_LIMIT}).`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      // Semantic search is not implemented yet (#11). Regardless of the
      // configured `embeddingBackend`, recall degrades to the
      // `embedding_disabled` signal rather than erroring, so hosts keep working
      // via `search` (ADR-0005). #11 will run real vector search here when
      // `embeddingBackend !== "disabled"`.
      const enabled = embeddingBackend !== "disabled";
      return jsonResult({
        hits: [],
        signal: EMBEDDING_DISABLED_SIGNAL,
        // Surface why recall is empty so the host can distinguish "no backend"
        // from "backend present but recall pending implementation".
        reason: enabled ? "recall_unimplemented" : "backend_disabled",
      });
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

    // --- propose.generate: frame host-produced content into HITL candidates. ---
    // No persistence: it only validates the items against the mode's allowed
    // candidate kinds and assigns each a stable id. The host LLM does the
    // reasoning (ADR-0006); approval + apply happen separately (ADR-0004).
    const modeList = PROPOSE_MODES.join(" / ");
    server.registerTool(
      "propose.generate",
      {
        title: "Propose (generate candidates)",
        description:
          `Frame host-produced reply/task/decision/triage candidates into a HITL ` +
          `proposal (modes: ${modeList}). Persists nothing — it validates and ` +
          `id-stamps the candidates so a human can approve a subset, then apply ` +
          `them via propose.apply. No auto-apply (ADR-0004).`,
        inputSchema: {
          mode: ProposeModeSchema.describe(`Generation mode (${modeList}).`),
          candidates: z
            .array(CandidateInputSchema)
            .min(1)
            .describe(
              "Host-produced candidate items. Allowed kinds per mode: " +
                PROPOSE_MODES.map((m) => `${m} → ${MODE_ALLOWED_KINDS[m].join("/")}`).join("; "),
            ),
        },
        annotations: { readOnlyHint: false, openWorldHint: false },
      },
      async ({ mode, candidates }) => {
        const result = proposeGenerate({ mode, candidates });
        return jsonResult(result);
      },
    );

    // --- propose.apply: persist approved candidates as events (idempotent). ---
    // Write tool (HITL): turns approved candidates into domain events. Re-applying
    // the same candidate is a no-op (content-derived ids), so it is idempotent.
    server.registerTool(
      "propose.apply",
      {
        title: "Propose (apply candidates)",
        description:
          "Persist approved candidates (from propose.generate) as domain events. " +
          "Write tool: requires human approval — no auto-apply (ADR-0004). " +
          "Idempotent: candidates whose entity already exists are skipped.",
        inputSchema: {
          candidates: z
            .array(CandidateSchema)
            .min(1)
            .describe("Approved, id-stamped candidates to apply."),
        },
        annotations: { readOnlyHint: false, openWorldHint: false },
      },
      async ({ candidates }) => {
        const result = proposeApply(write.store, { candidates });
        return jsonResult(result);
      },
    );

    // --- task.create: direct HITL task creation (Issue #12 追補 D2). ---
    // The human's own "add task" path (vs. model-suggested propose.*). Appends a
    // TaskProposed event → tasks projection. HITL, idempotent on content.
    server.registerTool(
      "task.create",
      {
        title: "Create task",
        description:
          "Create a task directly (appends TaskProposed → tasks projection). " +
          "Write tool: requires human approval — no auto-apply (ADR-0004). " +
          "Idempotent: re-creating the same task (title + provenance) is a no-op.",
        inputSchema: {
          title: z.string().min(1).describe("Task title."),
          sourceExternalIds: z
            .array(z.string().min(1))
            .optional()
            .describe("Source ids this task derives from (provenance)."),
        },
        annotations: { readOnlyHint: false, openWorldHint: false },
      },
      async ({ title, sourceExternalIds }) => {
        const result = taskCreate(write.store, {
          title,
          ...(sourceExternalIds !== undefined ? { sourceExternalIds } : {}),
        });
        return jsonResult(result);
      },
    );
  }

  return server;
}
