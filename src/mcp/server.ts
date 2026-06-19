/**
 * MCP server surface — the agent boundary (ADR-0004, docs/design/mcp-surface.md).
 *
 * Exposes Suasor's read tools over MCP using the official TypeScript SDK. The
 * read half: `search` (FTS5), `recall.search` (semantic vec0 KNN when an
 * embedding backend is enabled, else the `embedding_disabled` signal — #11),
 * `source.list` / `source.get`, `task.list` / `decision.list` / `inbox.list`,
 * `propose.list` (the proposal ledger by state, #89), and `person.list`
 * (resolved persons + their connector identities, ADR-0022 / #92). The write
 * tools — `connector.sync` (read-only ingest, ADR-0007 / #10), `propose.generate`
 * / `propose.apply` / `propose.reject` (HITL candidate generation + application +
 * rejection, #12 / #89), `task.create` (direct task creation, #12 追補 D2), the
 * direct daily-loop writes `decision.record` / `inbox.add` / `inbox.triage`
 * (Issue #88), the manual knowledge-graph link CRUD `link.add` / `link.remove`
 * (Issue #90), and the person identity resolution `person.merge` / `person.split`
 * (HITL, ADR-0022 / #92) — are registered when a writable `Store` + config are
 * supplied.
 * Write tools carry `readOnlyHint: false` so hosts gate them behind HITL (no
 * auto-apply, ADR-0004 / FR-PRO-2).
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
import { proposeApply } from "../propose/apply.ts";
import {
  CandidateInput as CandidateInputSchema,
  Candidate as CandidateSchema,
  MODE_ALLOWED_KINDS,
  PROPOSE_MODES,
  ProposeMode as ProposeModeSchema,
} from "../propose/candidates.ts";
import { decisionRecord } from "../propose/decision-record.ts";
import { persistProposals } from "../propose/generate.ts";
import { inboxAdd } from "../propose/inbox-add.ts";
import { inboxTriage, TRIAGE_ACTIONS, TriageError } from "../propose/inbox-triage.ts";
import { linkAdd } from "../propose/link-add.ts";
import { linkRemove } from "../propose/link-remove.ts";
import { personMerge } from "../propose/person-merge.ts";
import { personSplit } from "../propose/person-split.ts";
import { proposeReject } from "../propose/reject.ts";
import { taskCreate } from "../propose/task-create.ts";
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
  buildBrief,
  DEFAULT_LIST_LIMIT,
  expandGraph,
  getSource,
  listDecisions,
  listInbox,
  listLinks,
  listPersons,
  listProposals,
  listSlackDemand,
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
   * Operator Slack user ids for `slack.demand.list` `<@you>` mention detection
   * (ADR-0012), resolved from `[connectors.slack]` config. Empty/omitted →
   * demand falls back to DM-only unless the caller passes `selfUserId`.
   */
  slackSelfUserIds?: string[];
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
        "Suasor local-first work memory (ADR-0004). Read tools (readOnlyHint: " +
        "true) are safe to call autonomously. Default retrieval is `search` " +
        "(FTS5); `recall.search` adds semantic search only when an embedding backend " +
        "is enabled, otherwise it returns the `embedding_disabled` signal so you can " +
        "fall back to `search`. Write tools (readOnlyHint: false — connector.sync, " +
        "propose.generate, propose.apply, propose.reject, task.create, decision.record, " +
        "inbox.add, inbox.triage, link.add, link.remove, person.merge, person.split) are " +
        "HITL: gate them behind human approval, never auto-apply. propose.list (read) shows " +
        "the candidate ledger by state for the approve/reject loop; person.list (read) shows " +
        "resolved persons and their connector identities (ADR-0022).",
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

  // --- slack.demand.list ---
  server.registerTool(
    "slack.demand.list",
    {
      title: "List Slack demand",
      description:
        "List unread-worthy Slack signals — @mentions of you and DMs — newest first, " +
        "derived (read-only, FTS-first) from ingested slack_message sources (ADR-0012). " +
        "Use as a priority signal in next-actions / personal-brief.",
      inputSchema: {
        selfUserId: z
          .string()
          .min(1)
          .optional()
          .describe("Your Slack user id (Uxxxx) for @mention detection; falls back to config."),
        kinds: z
          .array(z.enum(["mention", "dm"]))
          .optional()
          .describe("Restrict to these kinds (default: both)."),
        observedAfter: isoDateTime.optional().describe("Inclusive lower bound on observed_at."),
        observedBefore: isoDateTime.optional().describe("Exclusive upper bound on observed_at."),
        limit: limitShape.describe(`Max rows (default ${DEFAULT_LIST_LIMIT}).`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ selfUserId, kinds, observedAfter, observedBefore, limit }) => {
      const selfUserIds = selfUserId ? [selfUserId] : (deps.slackSelfUserIds ?? []);
      const demand = listSlackDemand(sqlite, {
        selfUserIds,
        ...(kinds ? { kinds } : {}),
        observed: { after: observedAfter, before: observedBefore },
        limit,
      });
      return jsonResult({ demand });
    },
  );

  // --- brief ---
  server.registerTool(
    "brief",
    {
      title: "Period brief bundle",
      description:
        "Bundle the period's material — tasks/decisions updated, sources/Slack demand " +
        "observed, and currently-open inbox — for the host LLM to summarize in one " +
        "round-trip. Read-only; the tool gathers, the host composes the summary " +
        "(ADR-0017). Default window: the last 24h.",
      inputSchema: {
        since: isoDateTime.optional().describe("Window start (inclusive). Default: 24h ago."),
        until: isoDateTime.optional().describe("Window end (exclusive). Default: now."),
        limit: limitShape.describe(`Per-section max rows (default ${DEFAULT_LIST_LIMIT}).`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ since, until, limit }) => {
      const now = new Date();
      const effSince = since ?? new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
      const effUntil = until ?? now.toISOString();
      const brief = buildBrief(sqlite, {
        since: effSince,
        until: effUntil,
        ...(limit !== undefined ? { limit } : {}),
        selfUserIds: deps.slackSelfUserIds ?? [],
      });
      return jsonResult(brief);
    },
  );

  // --- graph.related ---
  server.registerTool(
    "graph.related",
    {
      title: "Related entities (1 hop)",
      description:
        "Provenance neighbours of an entity (kind + id) over the links projection — " +
        "1 hop in both directions (ADR-0018). Relations: derived_from / replies_to / " +
        "references / manual_link (the latter carry a `linkId` for link.remove). " +
        "Read-only; fetch bodies via source.get.",
      inputSchema: {
        kind: z.string().min(1).describe("Origin entity kind (e.g. task / decision / source)."),
        id: z.string().min(1).describe("Origin entity id."),
        direction: z
          .enum(["out", "in", "both"])
          .optional()
          .describe("Edge directions to follow (default: both)."),
        relation: z.string().min(1).optional().describe("Restrict to a single relation label."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ kind, id, direction, relation }) => {
      const neighbors = listLinks(sqlite, kind, id, {
        ...(direction ? { direction } : {}),
        ...(relation ? { relation } : {}),
      });
      return jsonResult({ origin: { kind, id }, neighbors });
    },
  );

  // --- graph.expand ---
  server.registerTool(
    "graph.expand",
    {
      title: "Expand graph (N hops)",
      description:
        "Breadth-first provenance expansion from an entity over the links projection, " +
        "bounded by depth + limit (ADR-0018). Returns reached nodes + the edges " +
        "between them. Read-only.",
      inputSchema: {
        kind: z.string().min(1).describe("Origin entity kind."),
        id: z.string().min(1).describe("Origin entity id."),
        depth: z.number().int().positive().max(10).optional().describe("Max hops (default 2)."),
        limit: limitShape.describe(`Max nodes (default ${DEFAULT_LIST_LIMIT}).`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ kind, id, depth, limit }) => {
      const expansion = expandGraph(sqlite, kind, id, {
        ...(depth !== undefined ? { depth } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      return jsonResult({ origin: { kind, id }, ...expansion });
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

  // --- propose.list: read the HITL proposal lifecycle ledger (Issue #89). ---
  // Read tool (readOnlyHint: true): the visibility half of the approve/reject
  // loop. Surfaces candidates by state (pending/applied/rejected) so a host can
  // show what is awaiting a human decision before calling the write tools.
  server.registerTool(
    "propose.list",
    {
      title: "List proposal candidates",
      description:
        "List generated HITL proposal candidates most-recently-updated first, " +
        "optionally filtered by state (pending / applied / rejected) and kind " +
        "(task / decision / reply_draft / triage). Read-only: the visibility half " +
        "of the propose approve/reject loop (apply/reject are separate write tools).",
      inputSchema: {
        state: z
          .enum(["pending", "applied", "rejected"])
          .optional()
          .describe("Filter by lifecycle state (default: all)."),
        kind: z
          .enum(["task", "decision", "reply_draft", "triage"])
          .optional()
          .describe("Filter by candidate kind (default: all)."),
        updatedAfter: isoDateTime.optional().describe("Inclusive lower bound on updated_at."),
        updatedBefore: isoDateTime.optional().describe("Exclusive upper bound on updated_at."),
        limit: limitShape.describe(`Max rows (default ${DEFAULT_LIST_LIMIT}).`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ state, kind, updatedAfter, updatedBefore, limit }) => {
      const proposals = listProposals(sqlite, {
        ...(state ? { state } : {}),
        ...(kind ? { kind } : {}),
        updated: { after: updatedAfter, before: updatedBefore },
        ...(limit !== undefined ? { limit } : {}),
      });
      return jsonResult({ proposals });
    },
  );

  // --- person.list: resolved persons + their connector identities (ADR-0022). ---
  // Read tool (readOnlyHint: true): the read half of person identity resolution.
  // Lists persons that connector author handles collapse into, each with its
  // `(connector, handle)` identities. Emptied persons (merged away) are hidden
  // unless `includeEmpty` is set. Merge/split are separate write tools.
  server.registerTool(
    "person.list",
    {
      title: "List persons",
      description:
        "List resolved persons most-recently-updated first, each with the connector " +
        "author identities (github login / slack Uxxxx / …) bound to it (ADR-0022). " +
        "Initial resolution is 1 handle = 1 person; operators collapse duplicates via " +
        "the person.merge / person.split write tools. Read-only.",
      inputSchema: {
        includeEmpty: z
          .boolean()
          .optional()
          .describe("Include persons left with no identities by a merge (default: false)."),
        limit: limitShape.describe(`Max rows (default ${DEFAULT_LIST_LIMIT}).`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ includeEmpty, limit }) => {
      const persons = listPersons(sqlite, {
        ...(includeEmpty !== undefined ? { includeEmpty } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      return jsonResult({ persons });
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
          `proposal (modes: ${modeList}). Validates and id-stamps the candidates, ` +
          `then records them in the proposal ledger as 'pending' (visible via ` +
          `propose.list) so a human can approve a subset (propose.apply) or reject ` +
          `(propose.reject). No domain entity is written until apply; no auto-apply ` +
          `(ADR-0004).`,
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
        const result = persistProposals(write.store, { mode, candidates });
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

    // --- propose.reject: reject a pending candidate with a reason (Issue #89). ---
    // Write tool (HITL): the reject half of the approve/reject loop. Flips a
    // pending proposal to `rejected` so it is no longer offered for approval.
    // Idempotent: re-rejecting is a no-op; an applied/missing candidate is
    // reported, not mutated (a rejected candidate cannot be applied).
    server.registerTool(
      "propose.reject",
      {
        title: "Propose (reject candidate)",
        description:
          "Reject a pending proposal candidate (from propose.generate) with an " +
          "optional reason, recording the decision in the proposal ledger. " +
          "Write tool: requires human approval — no auto-apply (ADR-0004). " +
          "Acts only on a pending candidate; an applied or missing one is reported, " +
          "not changed. Idempotent: re-rejecting is a no-op.",
        inputSchema: {
          candidateId: z.string().min(1).describe("Candidate id from propose.generate."),
          reason: z.string().optional().describe("Why the candidate is rejected (recorded)."),
        },
        annotations: { readOnlyHint: false, openWorldHint: false },
      },
      async ({ candidateId, reason }) => {
        const result = proposeReject(write.store, {
          candidateId,
          ...(reason !== undefined ? { reason } : {}),
        });
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

    // --- decision.record: direct HITL decision recording (Issue #88). ---
    // The decision counterpart to task.create: the human's own "log this
    // decision" path. Appends DecisionRecorded → decisions projection. HITL,
    // idempotent on content (title + provenance).
    server.registerTool(
      "decision.record",
      {
        title: "Record decision",
        description:
          "Record a decision directly (appends DecisionRecorded → decisions projection). " +
          "Write tool: requires human approval — no auto-apply (ADR-0004). " +
          "Idempotent: re-recording the same decision (title + provenance) is a no-op.",
        inputSchema: {
          title: z.string().min(1).describe("Decision title."),
          rationale: z.string().optional().describe("Why this decision was made."),
          sourceExternalIds: z
            .array(z.string().min(1))
            .optional()
            .describe("Source ids this decision derives from (provenance)."),
        },
        annotations: { readOnlyHint: false, openWorldHint: false },
      },
      async ({ title, rationale, sourceExternalIds }) => {
        const result = decisionRecord(write.store, {
          title,
          ...(rationale !== undefined ? { rationale } : {}),
          ...(sourceExternalIds !== undefined ? { sourceExternalIds } : {}),
        });
        return jsonResult(result);
      },
    );

    // --- inbox.add: capture an inbox item (Issue #88). ---
    // The capture half of the daily triage loop. Appends InboxItemTriaged in the
    // `open` state → inbox projection. HITL, idempotent on the captured source.
    server.registerTool(
      "inbox.add",
      {
        title: "Add inbox item",
        description:
          "Capture an inbox item referencing a source (appends InboxItemTriaged " +
          "in the `open` state → inbox projection). Write tool: requires human " +
          "approval — no auto-apply (ADR-0004). Idempotent: capturing the same " +
          "source twice is a no-op.",
        inputSchema: {
          sourceExternalId: z
            .string()
            .min(1)
            .describe("Source id the inbox item references (provenance)."),
        },
        annotations: { readOnlyHint: false, openWorldHint: false },
      },
      async ({ sourceExternalId }) => {
        const result = inboxAdd(write.store, { sourceExternalId });
        return jsonResult(result);
      },
    );

    // --- inbox.triage: resolve an open inbox item (Issue #88 state machine). ---
    // Moves an `open` item out of the inbox: task / decision creates the derived
    // entity + marks the item `done`; discard marks it `dismissed`. Only `open`
    // items may be triaged (invalid transitions are tool errors). HITL.
    const triageActions = TRIAGE_ACTIONS.join(" / ");
    server.registerTool(
      "inbox.triage",
      {
        title: "Triage inbox item",
        description:
          `Resolve an open inbox item (actions: ${triageActions}). \`task\` / ` +
          "`decision` create a derived task/decision from the item's source and " +
          "mark it `done`; `discard` marks it `dismissed`. Only `open` items may " +
          "be triaged. Write tool: requires human approval — no auto-apply (ADR-0004).",
        inputSchema: {
          inboxId: z.string().min(1).describe("Inbox item id to triage."),
          action: z.enum(TRIAGE_ACTIONS).describe(`Triage action (${triageActions}).`),
          title: z
            .string()
            .min(1)
            .optional()
            .describe("Title for the derived task/decision (required for task/decision)."),
          rationale: z.string().optional().describe("Rationale for the derived decision."),
        },
        annotations: { readOnlyHint: false, openWorldHint: false },
      },
      async ({ inboxId, action, title, rationale }) => {
        try {
          const result = inboxTriage(write.store, {
            inboxId,
            action,
            ...(title !== undefined ? { title } : {}),
            ...(rationale !== undefined ? { rationale } : {}),
          });
          return jsonResult(result);
        } catch (error) {
          // Invalid state-machine transitions surface as tool errors (not a crash)
          // so the host can show the rejection and the user can correct it.
          if (error instanceof TriageError) {
            return { isError: true, content: [{ type: "text" as const, text: error.message }] };
          }
          throw error;
        }
      },
    );

    // --- link.add: create a manual provenance link (Issue #90). ---
    // The human/agent's own "relate these two entities" path, beyond the
    // reducer-derived edges. Appends a LinkAdded event → links projection with
    // the `manual_link` relation (graph.related / graph.expand then traverse it).
    // Idempotent on the directed endpoint pair; self-loops are rejected. HITL.
    server.registerTool(
      "link.add",
      {
        title: "Add manual link",
        description:
          "Create a manual provenance link (relation `manual_link`) between two " +
          "entities so graph.related / graph.expand can traverse it — beyond the " +
          "reducer-derived edges (derived_from / replies_to / references). Write " +
          "tool: requires human approval — no auto-apply (ADR-0004). Idempotent: " +
          "re-adding the same directed link is a no-op; a self-loop is rejected.",
        inputSchema: {
          fromKind: z
            .string()
            .min(1)
            .describe("Origin entity kind (e.g. task / decision / source)."),
          fromId: z.string().min(1).describe("Origin entity id."),
          toKind: z.string().min(1).describe("Target entity kind."),
          toId: z.string().min(1).describe("Target entity id."),
        },
        annotations: { readOnlyHint: false, openWorldHint: false },
      },
      async ({ fromKind, fromId, toKind, toId }) => {
        try {
          const result = linkAdd(write.store, { fromKind, fromId, toKind, toId });
          return jsonResult(result);
        } catch (error) {
          // A self-loop (or other invalid input) surfaces as a tool error so the
          // host can show the rejection rather than crash.
          if (error instanceof Error) {
            return { isError: true, content: [{ type: "text" as const, text: error.message }] };
          }
          throw error;
        }
      },
    );

    // --- link.remove: delete a manual provenance link by id (Issue #90). ---
    // Removal half of the manual-link pair. Appends a LinkRemoved event → the
    // row disappears from links (audit-able via the add/remove event pair). Only
    // manual links (carrying a link_id) are removable; removing a non-existent
    // link is a tool error so the host surfaces the mistake. HITL.
    server.registerTool(
      "link.remove",
      {
        title: "Remove manual link",
        description:
          "Remove a manual link by its id (the `linkId` returned by link.add). " +
          "Only manual links are removable — reducer-derived provenance edges are " +
          "owned by the reducer. Write tool: requires human approval — no " +
          "auto-apply (ADR-0004). Removing a non-existent link is a tool error.",
        inputSchema: {
          linkId: z.string().min(1).describe("Manual link id to remove (from link.add)."),
        },
        annotations: { readOnlyHint: false, openWorldHint: false },
      },
      async ({ linkId }) => {
        try {
          const result = linkRemove(write.store, { linkId });
          return jsonResult(result);
        } catch (error) {
          // Removing an absent link surfaces as a tool error (not a crash) so the
          // host can show the rejection and the user can correct it.
          if (error instanceof Error) {
            return { isError: true, content: [{ type: "text" as const, text: error.message }] };
          }
          throw error;
        }
      },
    );

    // --- person.merge: collapse two persons into one (ADR-0022, Issue #92). ---
    // Write half of identity resolution: the operator's explicit "same human"
    // action (no fuzzy auto-merge). Appends PersonsMerged → the source person's
    // identities reassign to the target. HITL; reversible via person.split.
    server.registerTool(
      "person.merge",
      {
        title: "Merge persons",
        description:
          "Merge two resolved persons into one: reassign every identity of the source " +
          "person to the target (ADR-0022). Operator-driven — there is no automatic " +
          "fuzzy de-duplication. Write tool: requires human approval — no auto-apply " +
          "(ADR-0004). Reversible via person.split. A self-merge or unknown source " +
          "person is a tool error.",
        inputSchema: {
          targetPersonId: z
            .string()
            .min(1)
            .describe("Person that survives and absorbs the other's identities."),
          sourcePersonId: z
            .string()
            .min(1)
            .describe("Person whose identities move to the target (emptied)."),
        },
        annotations: { readOnlyHint: false, openWorldHint: false },
      },
      async ({ targetPersonId, sourcePersonId }) => {
        try {
          const result = personMerge(write.store, { targetPersonId, sourcePersonId });
          return jsonResult(result);
        } catch (error) {
          if (error instanceof Error) {
            return { isError: true, content: [{ type: "text" as const, text: error.message }] };
          }
          throw error;
        }
      },
    );

    // --- person.split: move one identity off a person (ADR-0022, Issue #92). ---
    // Inverse of merge: detach a single (connector, handle) identity and bind it
    // to another person (default: its own content-derived person — "undo a wrong
    // merge"). Appends PersonSplit. HITL; reversible via person.merge.
    server.registerTool(
      "person.split",
      {
        title: "Split person identity",
        description:
          "Split one (connector, handle) identity off its current person into another " +
          "person (ADR-0022) — the inverse of person.merge, to correct an over-merge. " +
          "Omit newPersonId to send the identity to its own content-derived person. " +
          "Write tool: requires human approval — no auto-apply (ADR-0004). An unknown " +
          "identity is a tool error.",
        inputSchema: {
          connector: z.string().min(1).describe("Connector of the identity to move out."),
          handle: z.string().min(1).describe("Handle of the identity to move out."),
          newPersonId: z
            .string()
            .min(1)
            .optional()
            .describe("Target person id (default: the identity's own content-derived person)."),
        },
        annotations: { readOnlyHint: false, openWorldHint: false },
      },
      async ({ connector, handle, newPersonId }) => {
        try {
          const result = personSplit(write.store, {
            connector,
            handle,
            ...(newPersonId !== undefined ? { newPersonId } : {}),
          });
          return jsonResult(result);
        } catch (error) {
          if (error instanceof Error) {
            return { isError: true, content: [{ type: "text" as const, text: error.message }] };
          }
          throw error;
        }
      },
    );
  }

  return server;
}
