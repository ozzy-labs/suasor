/**
 * MCP read-tool surface (ADR-0004, docs/design/mcp-surface.md) — the
 * side-effect-free half of the agent boundary, extracted verbatim from the
 * former monolithic `server.ts`.
 *
 * Read = no side effects: every tool here only SELECTs (queries.ts) or runs the
 * FTS-first / recall search services (retrieval/), and is annotated
 * `readOnlyHint: true` so MCP hosts may auto-approve them. recall embeds the
 * query via a sidecar/API client (ADR-0006) but performs no store mutation. The
 * split (read here, write in `server-write.ts`) is structural, not advisory.
 *
 * Registration order is preserved exactly so the tool catalog and any
 * order-sensitive host introspection stay byte-identical to the pre-split
 * server.
 */
import type { Database } from "bun:sqlite";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { EmbeddingConfig } from "../config/schema.ts";
import {
  DEFAULT_RECALL_LIMIT,
  EMBEDDING_DISABLED_SIGNAL,
  type Embedder,
  EmbeddingError,
  recallSearch,
} from "../retrieval/embedding/index.ts";
import { DEFAULT_RRF_K, fuseRrf } from "../retrieval/hybrid.ts";
import { DEFAULT_SEARCH_LIMIT, searchSources } from "../retrieval/search.ts";
import {
  buildBrief,
  DEFAULT_LIST_LIMIT,
  deriveBriefWarnings,
  expandGraph,
  getSource,
  listCommitments,
  listDecisions,
  listInbox,
  listLinks,
  listPersons,
  listProposals,
  listSlackDemand,
  listSourceHistory,
  listSources,
  listTasks,
} from "./queries.ts";
import { isoDateTime, jsonResult, limitShape, type McpServerDeps } from "./server-shared.ts";

/** Context the read tools close over (built once by the factory). */
export interface ReadToolContext {
  sqlite: Database;
  embedder: Embedder | null;
  embeddingConfig: Pick<EmbeddingConfig, "backend" | "baseUrl" | "model">;
  deps: McpServerDeps;
}

/** Register every read tool onto `server` in the original order. */
export function registerReadTools(server: McpServer, ctx: ReadToolContext): void {
  const { sqlite, embedder, embeddingConfig, deps } = ctx;

  // --- search: FTS-first full-text search (ADR-0005, the default path). ---
  server.registerTool(
    "search",
    {
      title: "Search",
      description:
        "Full-text search over ingested source bodies (SQLite FTS5, FTS-first). " +
        "Handles Japanese and English uniformly; short queries fall back to a " +
        "substring scan. Optionally filter by source_type and an " +
        "observed_after/observed_before window (lower bound inclusive, upper " +
        "exclusive). Returns ranked hits best-first.",
      inputSchema: {
        query: z.string().min(1).describe("Free-text query."),
        sourceType: z.string().min(1).optional().describe("Filter by source_type."),
        observedAfter: isoDateTime.optional().describe("Inclusive lower bound on observed_at."),
        observedBefore: isoDateTime.optional().describe("Exclusive upper bound on observed_at."),
        limit: limitShape.describe(`Max hits (default ${DEFAULT_SEARCH_LIMIT}).`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, sourceType, observedAfter, observedBefore, limit }) => {
      const result = searchSources(sqlite, query, {
        limit: limit ?? DEFAULT_SEARCH_LIMIT,
        ...(sourceType !== undefined ? { sourceType } : {}),
        ...(observedAfter !== undefined ? { observedAfter } : {}),
        ...(observedBefore !== undefined ? { observedBefore } : {}),
      });
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
        "`embedding_disabled` signal so the host can fall back to `search` (ADR-0005). " +
        "Optionally filter by source_type and an observed_after/observed_before " +
        "window (lower bound inclusive, upper exclusive; applied as a post-filter).",
      inputSchema: {
        query: z.string().min(1).describe("Free-text query."),
        sourceType: z.string().min(1).optional().describe("Filter by source_type."),
        observedAfter: isoDateTime.optional().describe("Inclusive lower bound on observed_at."),
        observedBefore: isoDateTime.optional().describe("Exclusive upper bound on observed_at."),
        limit: limitShape.describe(`Max hits (default ${DEFAULT_RECALL_LIMIT}).`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, sourceType, observedAfter, observedBefore, limit }) => {
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
          ...(sourceType !== undefined ? { sourceType } : {}),
          ...(observedAfter !== undefined ? { observedAfter } : {}),
          ...(observedBefore !== undefined ? { observedBefore } : {}),
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

  // --- search.hybrid: RRF fusion of FTS + semantic hits (ADR-0005 range). ---
  // Read tool: runs `search` (FTS) and `recall.search` (vec) and fuses the two
  // ranked lists with Reciprocal Rank Fusion (src/retrieval/hybrid.ts), so each
  // path covers the other's blind spot. When no embedding backend is available
  // — or the sidecar is unreachable — it gracefully degrades to FTS-only and
  // reports the `embedding_disabled` signal (same contract as recall.search).
  server.registerTool(
    "search.hybrid",
    {
      title: "Hybrid search (FTS × semantic RRF)",
      description:
        "Hybrid retrieval: fuse FTS (`search`) and semantic (`recall.search`) hits " +
        "with Reciprocal Rank Fusion, so lexical and semantic matches reinforce each " +
        "other (best of both). Filters (source_type + observed window) and limit apply " +
        "to both paths. When no embedding backend is enabled — or the sidecar is " +
        "unreachable — it degrades to FTS-only and returns the `embedding_disabled` " +
        "signal (ADR-0005). Hits carry an `rrfScore` (higher = better, best-first).",
      inputSchema: {
        query: z.string().min(1).describe("Free-text query."),
        sourceType: z.string().min(1).optional().describe("Filter by source_type."),
        observedAfter: isoDateTime.optional().describe("Inclusive lower bound on observed_at."),
        observedBefore: isoDateTime.optional().describe("Exclusive upper bound on observed_at."),
        limit: limitShape.describe(`Max fused hits (default ${DEFAULT_SEARCH_LIMIT}).`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, sourceType, observedAfter, observedBefore, limit }) => {
      const effLimit = limit ?? DEFAULT_SEARCH_LIMIT;
      const filters = {
        ...(sourceType !== undefined ? { sourceType } : {}),
        ...(observedAfter !== undefined ? { observedAfter } : {}),
        ...(observedBefore !== undefined ? { observedBefore } : {}),
      };
      const fts = searchSources(sqlite, query, { limit: effLimit, ...filters });

      // Resolve the vec side, degrading to FTS-only on no/failed backend so the
      // tool always returns fused (here: FTS) results rather than erroring.
      let vecHits = [] as Awaited<ReturnType<typeof recallSearch>>["hits"];
      let signal: typeof EMBEDDING_DISABLED_SIGNAL | undefined;
      if (embedder === null) {
        signal = EMBEDDING_DISABLED_SIGNAL;
      } else {
        try {
          const recall = await recallSearch(sqlite, embedder, query, {
            limit: effLimit,
            ...filters,
          });
          vecHits = recall.hits;
          signal = recall.signal;
        } catch (error) {
          if (error instanceof EmbeddingError) {
            signal = EMBEDDING_DISABLED_SIGNAL;
          } else {
            throw error;
          }
        }
      }

      const hits = fuseRrf(fts.hits, vecHits, { k: DEFAULT_RRF_K, limit: effLimit });
      return jsonResult({ hits, ...(signal ? { signal } : {}) });
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

  server.registerTool(
    "source.history",
    {
      title: "Get source body history",
      description:
        "List a source's body versions from the event log, newest first. Unlike " +
        "source.get (current body only), this reconstructs every version from the " +
        "append-only events (SourceObserved / SourceBodyUpdated both retain the full " +
        "body), enabling a true before/after diff. Read-only.",
      inputSchema: {
        externalId: z.string().min(1).describe("Connector-assigned source id."),
        limit: limitShape.describe(`Max versions, newest first (default ${DEFAULT_LIST_LIMIT}).`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ externalId, limit }) => {
      const versions = listSourceHistory(sqlite, externalId, {
        ...(limit !== undefined ? { limit } : {}),
      });
      return jsonResult({ versions });
    },
  );

  // --- task.list ---
  server.registerTool(
    "task.list",
    {
      title: "List tasks",
      description:
        "List tasks most-recently-updated first, optionally filtered by state, an " +
        "updated_after/updated_before time window, dueBefore, dueWithinDays (today/this " +
        "week's priority), or overdue. Each task carries dueDate / priority and a " +
        "read-time-derived overdue flag (ADR-0028).",
      inputSchema: {
        state: z.string().min(1).optional().describe("Filter by lifecycle state."),
        updatedAfter: isoDateTime.optional().describe("Inclusive lower bound on updated_at."),
        updatedBefore: isoDateTime.optional().describe("Exclusive upper bound on updated_at."),
        dueBefore: isoDateTime
          .optional()
          .describe("Keep only tasks with a due date before this (ISO 8601, ADR-0028)."),
        dueWithinDays: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Keep only tasks due within the next N days of now (due soon; 7 = the week, ADR-0028).",
          ),
        overdue: z
          .boolean()
          .optional()
          .describe("Keep only overdue tasks (past due AND open/in_progress, ADR-0028)."),
        limit: limitShape.describe(`Max rows (default ${DEFAULT_LIST_LIMIT}).`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ state, updatedAfter, updatedBefore, dueBefore, dueWithinDays, overdue, limit }) => {
      const tasks = listTasks(sqlite, {
        state,
        updated: { after: updatedAfter, before: updatedBefore },
        dueBefore,
        ...(dueWithinDays !== undefined ? { dueWithinDays } : {}),
        overdue,
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
        // Completeness signals (Issue #189): mark categories empty because they
        // are unconfigured (Slack not wired / embedding disabled) so the host
        // can distinguish "not connected" from "genuinely quiet".
        warnings: deriveBriefWarnings({
          slackConfigured: deps.slackConfigured ?? (deps.slackSelfUserIds ?? []).length > 0,
          embeddingBackend: embeddingConfig.backend,
        }),
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
        "bounded by depth + limit (ADR-0018). direction bounds each hop: both (default), " +
        "in for a backward provenance trace (graph trace), or out for downstream expansion " +
        "(ADR-0020). Returns reached nodes + the edges between them. Read-only.",
      inputSchema: {
        kind: z.string().min(1).describe("Origin entity kind."),
        id: z.string().min(1).describe("Origin entity id."),
        depth: z.number().int().positive().max(10).optional().describe("Max hops (default 2)."),
        direction: z
          .enum(["out", "in", "both"])
          .optional()
          .describe(
            "Edge directions to follow per hop (default: both). in = backward provenance trace.",
          ),
        limit: limitShape.describe(`Max nodes (default ${DEFAULT_LIST_LIMIT}).`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ kind, id, depth, direction, limit }) => {
      const expansion = expandGraph(sqlite, kind, id, {
        ...(depth !== undefined ? { depth } : {}),
        ...(direction ? { direction } : {}),
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
        "List inbox items most-recently-updated first, optionally filtered by state, " +
        "the underlying source's sourceType (e.g. slack_message), and an " +
        "updated_after/updated_before time window.",
      inputSchema: {
        state: z.string().min(1).optional().describe("Filter by triage state."),
        sourceType: z
          .string()
          .min(1)
          .optional()
          .describe("Filter by the underlying source's source_type (e.g. slack_message)."),
        updatedAfter: isoDateTime.optional().describe("Inclusive lower bound on updated_at."),
        updatedBefore: isoDateTime.optional().describe("Exclusive upper bound on updated_at."),
        limit: limitShape.describe(`Max rows (default ${DEFAULT_LIST_LIMIT}).`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ state, sourceType, updatedAfter, updatedBefore, limit }) => {
      const items = listInbox(sqlite, {
        state,
        ...(sourceType !== undefined ? { sourceType } : {}),
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
        "(task / decision / reply_draft / triage / commitment). Each row carries " +
        "its `reason` (populated for rejected candidates). Read-only: the " +
        "visibility half of the propose approve/reject loop (apply/reject/batch " +
        "are separate write tools).",
      inputSchema: {
        state: z
          .enum(["pending", "applied", "rejected"])
          .optional()
          .describe("Filter by lifecycle state (default: all)."),
        kind: z
          .enum(["task", "decision", "reply_draft", "triage", "commitment"])
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

  // --- commitment.list: read the commitment ledger by state (ADR-0021). ---
  // Read tool (readOnlyHint: true): outstanding "約束/コミットメント" so a host
  // can surface them as a "やるべきこと" priority signal alongside Slack demand
  // in next-actions / personal-brief. Filter by state and direction.
  server.registerTool(
    "commitment.list",
    {
      title: "List commitments",
      description:
        "List commitments most-recently-updated first, optionally filtered by " +
        "state (open / resolved / dismissed), direction (owed_by_me / " +
        "owed_to_me), and the related person (exact match — chase a specific " +
        "person). Read-only: the visibility half of the commitment ledger " +
        "(ADR-0021). Use as a priority signal in next-actions / personal-brief; " +
        "the resolve/dismiss/reopen lifecycle lives in separate write tools.",
      inputSchema: {
        state: z
          .enum(["open", "resolved", "dismissed"])
          .optional()
          .describe("Filter by lifecycle state (default: all)."),
        direction: z
          .enum(["owed_by_me", "owed_to_me"])
          .optional()
          .describe("Filter by direction (default: both)."),
        person: z
          .string()
          .min(1)
          .optional()
          .describe("Filter by related person (exact match, default: any)."),
        updatedAfter: isoDateTime.optional().describe("Inclusive lower bound on updated_at."),
        updatedBefore: isoDateTime.optional().describe("Exclusive upper bound on updated_at."),
        limit: limitShape.describe(`Max rows (default ${DEFAULT_LIST_LIMIT}).`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ state, direction, person, updatedAfter, updatedBefore, limit }) => {
      const commitments = listCommitments(sqlite, {
        ...(state ? { state } : {}),
        ...(direction ? { direction } : {}),
        ...(person !== undefined ? { person } : {}),
        updated: { after: updatedAfter, before: updatedBefore },
        ...(limit !== undefined ? { limit } : {}),
      });
      return jsonResult({ commitments });
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
}
