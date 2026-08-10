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
import { deriveSyncFreshness, type SyncFreshness } from "../connectors/freshness.ts";
import {
  DEFAULT_RECALL_LIMIT,
  EMBEDDING_DISABLED_SIGNAL,
  type Embedder,
  EmbeddingError,
  recallSearch,
} from "../retrieval/embedding/index.ts";
import { DEFAULT_RRF_K, fuseRrf } from "../retrieval/hybrid.ts";
import { DEFAULT_EXCERPT_CHARS, DEFAULT_SEARCH_LIMIT, searchSources } from "../retrieval/search.ts";
import {
  buildActivityTimeline,
  buildBrief,
  buildPriorities,
  DEFAULT_LIST_LIMIT,
  DEMAND_SOURCES,
  deriveBriefWarnings,
  deriveCommitmentScanStaleness,
  expandGraph,
  findDuplicatePersonCandidates,
  getSource,
  getSourceFull,
  listCommitments,
  listDecisions,
  listDemand,
  listInbox,
  listLinks,
  listPersons,
  listProposals,
  listSourceHistory,
  listSources,
  listSyncRuns,
  listTasks,
  listWithTruncation,
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

  // Sync freshness (Issue #442), derived at read time from `sync_runs` + the
  // `[sync]` cadence expectations. Shared by `sync.status` and the brief's
  // `sync_stale` warning so the two can never disagree about what is behind.
  // Returns `undefined` when the host did not supply the config (older embeds).
  const freshness = (): SyncFreshness[] | undefined => {
    const cfg = deps.sync;
    if (cfg === undefined) return undefined;
    return deriveSyncFreshness(cfg.enabledConnectors, listSyncRuns(sqlite), {
      expectedIntervalHours: cfg.expectedIntervalHours,
      safetyFactor: cfg.safetyFactor,
      perConnectorIntervalHours: cfg.perConnectorIntervalHours,
    });
  };

  // Shared body-projection args for the retrieval tool (`search`, every mode).
  // By default each hit returns a bounded excerpt, not the full
  // body, so a multi-hit response can't overflow the host context; the full text
  // is fetched via source.get (retrieval-m2 / ADR-0018 payload suppression).
  const fullBodyShape = z
    .boolean()
    .optional()
    .describe(
      "Return each hit's full body instead of a bounded excerpt (default: excerpt only — fetch full text via source.get).",
    );
  const maxBodyCharsShape = z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`Max characters per hit excerpt (default ${DEFAULT_EXCERPT_CHARS}).`);

  // --- search: the single retrieval entry point (ADR-0046 決定 2). ---
  // Was three tools (`search` / `recall.search` / `search.hybrid`), which pushed
  // the choice of *retrieval algorithm* onto a host that was only asked to find
  // something — and got it wrong in both directions (semantic when embeddings are
  // off, FTS when they are on). `mode` keeps every path reachable, and `auto`
  // (the default) picks the best available one from the backend state.
  server.registerTool(
    "search",
    {
      title: "Search",
      description:
        "Search ingested source bodies. `mode` selects the retrieval path and " +
        "defaults to `auto`: hybrid (FTS × semantic, RRF-fused) when an embedding " +
        "backend is available, plain FTS otherwise — so callers do not have to know " +
        "the backend state. `fts` is SQLite FTS5 (handles Japanese and English " +
        "uniformly; short queries fall back to a per-token substring scan). " +
        "`semantic` is vec0 KNN, crossing the wall FTS cannot (JA↔EN, vocabulary " +
        "mismatch). `hybrid` fuses both with Reciprocal Rank Fusion. When a semantic " +
        "path is requested but unavailable, results degrade (to empty for `semantic`, " +
        "to FTS-only for `hybrid`/`auto`) and carry an `embedding_disabled` signal " +
        "(ADR-0005) — never an error. Optionally filter by source_type and an " +
        "observed_after/observed_before window (lower bound inclusive, upper " +
        "exclusive). Each hit carries a bounded `excerpt` (not the full body) by " +
        "default — fetch full text via source.get, or pass fullBody=true (ADR-0018).",
      inputSchema: {
        query: z.string().min(1).describe("Free-text query."),
        mode: z
          .enum(["auto", "fts", "semantic", "hybrid"])
          .optional()
          .describe(
            "Retrieval path (default `auto`: hybrid when embeddings are available, else fts).",
          ),
        sourceType: z.string().min(1).optional().describe("Filter by source_type."),
        observedAfter: isoDateTime.optional().describe("Inclusive lower bound on observed_at."),
        observedBefore: isoDateTime.optional().describe("Exclusive upper bound on observed_at."),
        limit: limitShape.describe(
          // Both paths default to the same value; asserted in tests so a future
          // divergence can't silently make this description wrong for one mode.
          `Max hits (default ${DEFAULT_SEARCH_LIMIT}).`,
        ),
        fullBody: fullBodyShape,
        maxBodyChars: maxBodyCharsShape,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({
      query,
      mode,
      sourceType,
      observedAfter,
      observedBefore,
      limit,
      fullBody,
      maxBodyChars,
    }) => {
      // `auto` resolves against the *actual* backend state, which is exactly the
      // judgement a host cannot make reliably from a tool catalog.
      const effMode =
        mode === undefined || mode === "auto" ? (embedder === null ? "fts" : "hybrid") : mode;
      const filters = {
        ...(sourceType !== undefined ? { sourceType } : {}),
        ...(observedAfter !== undefined ? { observedAfter } : {}),
        ...(observedBefore !== undefined ? { observedBefore } : {}),
      };
      const bodyOpts = {
        ...(fullBody !== undefined ? { fullBody } : {}),
        ...(maxBodyChars !== undefined ? { maxBodyChars } : {}),
      };

      if (effMode === "fts") {
        const result = searchSources(sqlite, query, {
          limit: limit ?? DEFAULT_SEARCH_LIMIT,
          ...filters,
          ...bodyOpts,
        });
        return jsonResult({ ...result, mode: "fts" });
      }

      if (effMode === "semantic") {
        const effLimit = limit ?? DEFAULT_RECALL_LIMIT;
        const degraded = (reason: string) =>
          jsonResult({ hits: [], signal: EMBEDDING_DISABLED_SIGNAL, reason, mode: "semantic" });
        if (embedder === null) return degraded("backend_disabled");
        try {
          const result = await recallSearch(sqlite, embedder, query, {
            limit: effLimit,
            ...filters,
            ...bodyOpts,
          });
          return jsonResult({ ...result, mode: "semantic" });
        } catch (error) {
          // A sidecar failure (Ollama down, etc.) must NOT hard-error: degrade to
          // the same signal so the host keeps working (ADR-0005).
          if (error instanceof EmbeddingError) return degraded("backend_unreachable");
          throw error;
        }
      }

      // hybrid: fuse FTS + semantic so each path covers the other's blind spot,
      // degrading to FTS-only (with the signal) when the vec side is unavailable.
      const effLimit = limit ?? DEFAULT_SEARCH_LIMIT;
      const fts = searchSources(sqlite, query, { limit: effLimit, ...filters, ...bodyOpts });
      let vecHits = [] as Awaited<ReturnType<typeof recallSearch>>["hits"];
      let signal: typeof EMBEDDING_DISABLED_SIGNAL | undefined;
      if (embedder === null) {
        signal = EMBEDDING_DISABLED_SIGNAL;
      } else {
        try {
          const recall = await recallSearch(sqlite, embedder, query, {
            limit: effLimit,
            ...filters,
            ...bodyOpts,
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
      return jsonResult({ hits, mode: "hybrid", ...(signal ? { signal } : {}) });
    },
  );

  // --- source.list / source.get ---
  server.registerTool(
    "source.list",
    {
      title: "List sources",
      description:
        "List ingested sources newest-first (by observed_at), optionally filtered " +
        "by source_type, an observed_after/observed_before window, and — for " +
        "calendar events — a starts_after/starts_before window over the event's " +
        "own start time (ADR-0044). Returns " +
        "`truncated: true` when more rows match than `limit` returned (ADR-0007 — " +
        "page with a tighter window rather than trusting a full page is complete).",
      inputSchema: {
        sourceType: z.string().min(1).optional().describe("Filter by source_type."),
        observedAfter: isoDateTime.optional().describe("Inclusive lower bound on observed_at."),
        observedBefore: isoDateTime.optional().describe("Exclusive upper bound on observed_at."),
        startsAfter: isoDateTime
          .optional()
          .describe(
            "Calendar events only: inclusive lower bound on the event's own start time. " +
              "Use this for 'next week's meetings' — an observed_at window answers a " +
              "different question (recently *edited* events).",
          ),
        startsBefore: isoDateTime
          .optional()
          .describe("Calendar events only: exclusive upper bound on the event's own start time."),
        limit: limitShape.describe(`Max rows (default ${DEFAULT_LIST_LIMIT}).`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ sourceType, observedAfter, observedBefore, startsAfter, startsBefore, limit }) => {
      const effLimit = limit ?? DEFAULT_LIST_LIMIT;
      const { rows: sources, truncated } = listWithTruncation(effLimit, (probeLimit) =>
        listSources(sqlite, {
          sourceType,
          observed: { after: observedAfter, before: observedBefore },
          ...(startsAfter !== undefined || startsBefore !== undefined
            ? { startsBetween: { after: startsAfter, before: startsBefore } }
            : {}),
          limit: probeLimit,
        }),
      );
      return jsonResult({ sources, truncated });
    },
  );

  // `source.get` absorbed the former `source.get.full` (ADR-0046 決定 2): the
  // difference was never a different question, only how much of the answer to
  // bundle — which is an argument, not a second tool.
  server.registerTool(
    "source.get",
    {
      title: "Get source",
      description:
        "Fetch a single ingested source (including its body) by external_id. Pass " +
        "`include` to bundle related material in the same round-trip: `links` adds " +
        "its outgoing provenance links (graph.related direction=out), `extraction` " +
        "adds its document-extraction sidecar (extraction_meta, ADR-0024) — what " +
        "otherwise costs three calls (Issue #279). Read-only. An unknown id returns " +
        "`source: null` (no error), with the requested sections empty.",
      inputSchema: {
        externalId: z.string().min(1).describe("Connector-assigned source id."),
        include: z
          .array(z.enum(["links", "extraction"]))
          .optional()
          .describe("Extra sections to bundle (default: none — source only)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ externalId, include }) => {
      if (include === undefined || include.length === 0) {
        return jsonResult({ source: getSource(sqlite, externalId) });
      }
      // getSourceFull already assembles all three in one pass; project down to
      // the requested sections so the response never carries more than asked.
      const full = getSourceFull(sqlite, externalId);
      return jsonResult({
        source: full.source,
        ...(include.includes("links") ? { links: full.links } : {}),
        ...(include.includes("extraction") ? { extractionMeta: full.extractionMeta } : {}),
      });
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
        "read-time-derived overdue flag (ADR-0028). Returns `truncated: true` when " +
        "more rows match than `limit` returned (ADR-0007).",
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
      const effLimit = limit ?? DEFAULT_LIST_LIMIT;
      const { rows: tasks, truncated } = listWithTruncation(effLimit, (probeLimit) =>
        listTasks(sqlite, {
          state,
          updated: { after: updatedAfter, before: updatedBefore },
          dueBefore,
          ...(dueWithinDays !== undefined ? { dueWithinDays } : {}),
          overdue,
          limit: probeLimit,
        }),
      );
      return jsonResult({ tasks, truncated });
    },
  );

  // --- decision.list ---
  server.registerTool(
    "decision.list",
    {
      title: "List decisions",
      description:
        "List recorded decisions most-recently-recorded first, optionally filtered " +
        "by a recorded_after/recorded_before time window. Returns `truncated: true` " +
        "when more rows match than `limit` returned (ADR-0007).",
      inputSchema: {
        recordedAfter: isoDateTime.optional().describe("Inclusive lower bound on recorded_at."),
        recordedBefore: isoDateTime.optional().describe("Exclusive upper bound on recorded_at."),
        limit: limitShape.describe(`Max rows (default ${DEFAULT_LIST_LIMIT}).`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ recordedAfter, recordedBefore, limit }) => {
      const effLimit = limit ?? DEFAULT_LIST_LIMIT;
      const { rows: decisions, truncated } = listWithTruncation(effLimit, (probeLimit) =>
        listDecisions(sqlite, {
          recorded: { after: recordedAfter, before: recordedBefore },
          limit: probeLimit,
        }),
      );
      return jsonResult({ decisions, truncated });
    },
  );

  // --- demand.list (ADR-0041, replaces slack.demand.list) ---
  server.registerTool(
    "demand.list",
    {
      title: "List demand",
      description:
        "List connector-neutral, unread-worthy demand signals — derived (read-only, " +
        "FTS-first, no extra fetch) from ingested sources (ADR-0041): Slack @mentions of " +
        "you + DMs (source `slack`, kind `mention`/`dm`, ADR-0012), demand-worthy github " +
        "notifications (source `github`, kind = the notification reason: review_requested / " +
        "mention / team_mention / assign / author), unanswered mail threads addressed to " +
        "you (source `email`, kind `to`/`cc`, ADR-0043 — replying resolves them, no ack " +
        "needed) and upcoming meetings (source `calendar`, kind `meeting_soon` ≤2h / " +
        "`meeting_prep` ≤24h with an agenda, attachments or you organizing; ADR-0044 — " +
        "declined, optional-only and all-day events are excluded, and they leave the list " +
        "when they start). Calendar rows lead the list ordered by start time (soonest " +
        "first); everything else follows newest-observed-first. Slack rows " +
        "carry `channelName` / `userName` / `teamName` joined locally from the " +
        "slack_channels / person_identities / slack_teams projections (ADR-0037), or `null` " +
        "when unresolved / for github (fall back to `meta`); never live-fetched. Returns " +
        "only OUTSTANDING (un-acked) demand by default — rows marked seen via demand.mark, " +
        "or a github notification already read (`meta.unread=false`), are " +
        "hidden so 'unprocessed' is true (ADR-0041 supersedes ADR-0012 決定 4). Pass " +
        "includeSeen=true to return all with `seenState` populated. Use as the priority " +
        "signal in next-actions / brief. Returns `truncated: true` when more rows " +
        "match than `limit` returned (ADR-0007).",
      inputSchema: {
        selfUserId: z
          .string()
          .min(1)
          .optional()
          .describe("Your Slack user id (Uxxxx) for @mention detection; falls back to config."),
        source: z
          .enum(DEMAND_SOURCES)
          .optional()
          .describe("Restrict to a single source family (default: all four)."),
        kinds: z
          .array(z.string().min(1))
          .optional()
          .describe(
            "Restrict to these kinds (Slack mention/dm, a github reason, email to/cc, " +
              "calendar meeting_soon/meeting_prep; default: all).",
          ),
        includeSeen: z
          .boolean()
          .optional()
          .describe("Include acked / dismissed / github-read rows (default: un-acked only)."),
        observedAfter: isoDateTime.optional().describe("Inclusive lower bound on observed_at."),
        observedBefore: isoDateTime.optional().describe("Exclusive upper bound on observed_at."),
        limit: limitShape.describe(`Max rows (default ${DEFAULT_LIST_LIMIT}).`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ selfUserId, source, kinds, includeSeen, observedAfter, observedBefore, limit }) => {
      const selfUserIds = selfUserId ? [selfUserId] : (deps.slackSelfUserIds ?? []);
      const effLimit = limit ?? DEFAULT_LIST_LIMIT;
      const { rows: demand, truncated } = listWithTruncation(effLimit, (probeLimit) =>
        listDemand(sqlite, {
          selfUserIds,
          ...(deps.selfAddresses !== undefined ? { selfAddresses: deps.selfAddresses } : {}),
          ...(source ? { source } : {}),
          ...(kinds ? { kinds } : {}),
          ...(includeSeen !== undefined ? { includeSeen } : {}),
          observed: { after: observedAfter, before: observedBefore },
          limit: probeLimit,
        }),
      );
      return jsonResult({ demand, truncated });
    },
  );

  // --- priority.list (ADR-0041, deterministic cross-entity scorer) ---
  server.registerTool(
    "priority.list",
    {
      title: "Ranked next-actions",
      description:
        "Deterministic cross-entity next-actions ranking (ADR-0041 / ADR-0045): " +
        "open/in-progress tasks + open commitments + outstanding (un-acked) demand, merged " +
        "into one ranked list so identical input always yields identical order. The ranking " +
        "basis lives in code, not skill prose: one hard tier (a meeting starting within 30 " +
        "minutes, which nothing outranks) above a weighted score combining how overdue, how " +
        "long unanswered, demand freshness, due-date proximity, meeting-prep urgency and " +
        "declared priority. Each row carries `reason` (the term that contributed most), " +
        "`explanation` (that term in words — show this, not the number), `score`, and the " +
        "underlying `record`. An acked mention drops out of demand entirely, so it can no " +
        "longer sit permanently above dated work. next-actions / brief consume this " +
        "baseline; the host may still override with conversational context. Returns " +
        "`truncated: true` when more candidates matched than `limit` returned (ADR-0007).",
      inputSchema: {
        selfUserId: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Your Slack user id (Uxxxx) for demand @mention detection; falls back to config.",
          ),
        limit: limitShape.describe(`Max ranked rows (default ${DEFAULT_LIST_LIMIT}).`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ selfUserId, limit }) => {
      const selfUserIds = selfUserId ? [selfUserId] : (deps.slackSelfUserIds ?? []);
      const priorities = buildPriorities(sqlite, {
        selfUserIds,
        ...(deps.selfAddresses !== undefined ? { selfAddresses: deps.selfAddresses } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      return jsonResult(priorities);
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
        "(ADR-0017). Default window: the last 24h. Carries a per-section " +
        "`truncated: { sources, tasks, decisions, inbox, demand }` map — a section is " +
        "`true` when it held more rows than `limit` returned (ADR-0007 'no silent wrong " +
        "answer'); narrow the window or page via the matching list tool when set.",
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
        ...(deps.selfAddresses !== undefined ? { selfAddresses: deps.selfAddresses } : {}),
        // Completeness signals (Issue #189): mark categories empty because they
        // are unconfigured (Slack not wired / embedding disabled) so the host
        // can distinguish "not connected" from "genuinely quiet".
        warnings: deriveBriefWarnings({
          slackConfigured: deps.slackConfigured ?? (deps.slackSelfUserIds ?? []).length > 0,
          embeddingBackend: embeddingConfig.backend,
          // Stale ingest is the third way a bundle can be empty for a reason
          // that has nothing to do with the window being quiet (Issue #442).
          ...(() => {
            const f = freshness();
            return f !== undefined ? { syncFreshness: f } : {};
          })(),
          // Ingested material nobody has scanned for promises (Issue #443):
          // the ledger degrades silently, since a missed commitment produces no
          // error — only an absence.
          commitmentScan: deriveCommitmentScanStaleness(sqlite),
        }),
      });
      return jsonResult(brief);
    },
  );

  // --- sync.status ---
  // Read tool (readOnlyHint: true): the ingest-freshness view the secretary
  // needs to caveat its own answers (Issue #442). `suasor sync status` has shown
  // this at the CLI since ADR-0033, but an agent had no way to ask — so a store
  // frozen by a broken cron entry produced confident, silently week-old answers.
  server.registerTool(
    "sync.status",
    {
      title: "Sync status / data freshness",
      description:
        "Per-connector ingest freshness: the latest sync run (start / end / status / " +
        "counts) plus a derived verdict — ok / stale / never / failing — against the " +
        "configured cadence ([sync], Issue #442). Use it to caveat an answer whose " +
        "data may be behind, or to explain an empty result that is a stopped sync " +
        "rather than a quiet week. Read-only; derived at read time (nothing stored).",
      inputSchema: {
        staleOnly: z
          .boolean()
          .optional()
          .describe("Return only connectors that are not ok (stale / never / failing)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ staleOnly }) => {
      const runs = listSyncRuns(sqlite);
      const derived = freshness();
      // No `[sync]` context (a host that embedded the server without config):
      // report the raw runs rather than inventing a verdict.
      if (derived === undefined) {
        return jsonResult({ runs, freshness: null, stale: null });
      }
      const shown = staleOnly === true ? derived.filter((f) => f.state !== "ok") : derived;
      return jsonResult({
        runs,
        freshness: shown,
        stale: derived.filter((f) => f.state !== "ok").map((f) => f.connector),
      });
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

  // --- activity.timeline: entity-axis merged source/task/decision view. ---
  // Read tool (readOnlyHint: true): where `brief` is period-axis, this is
  // entity-axis — walk the provenance graph from an entity (person/project/source/
  // …) and merge the connected sources/tasks/decisions into one time-ordered
  // timeline (Issue #279). Reuses the existing query layer (buildActivityTimeline:
  // expandGraph + getSource/getTask/getDecision → merge → sort newest-first).
  server.registerTool(
    "activity.timeline",
    {
      title: "Activity timeline (entity-axis)",
      description:
        "Merge the sources / tasks / decisions provenance-connected to an entity " +
        "(kind + id — person / project / source / …) into one time-ordered view, " +
        "newest-first (Issue #279). Where `brief` is period-axis only, this is " +
        'entity-axis: "everything around this entity". Walks the links projection ' +
        "from the origin (bounded by `depth`), stamps each item with its natural " +
        "timestamp (source observed / task updated / decision recorded), applies the " +
        "optional observed/updated/recorded window, then sorts + caps to limit. " +
        "Completeness is bounded by `depth` (the graph walk truncates breadth-first " +
        "before the newest-first sort), so raise `depth` for sparse, distant " +
        "provenance. Read-only.",
      inputSchema: {
        kind: z.string().min(1).describe("Origin entity kind (e.g. person / source / project)."),
        id: z.string().min(1).describe("Origin entity id."),
        depth: z
          .number()
          .int()
          .positive()
          .max(10)
          .optional()
          .describe("Provenance hops to walk from the origin (default 2)."),
        after: isoDateTime.optional().describe("Inclusive lower bound on each item's timestamp."),
        before: isoDateTime.optional().describe("Exclusive upper bound on each item's timestamp."),
        limit: limitShape.describe(`Max items, newest-first (default ${DEFAULT_LIST_LIMIT}).`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ kind, id, depth, after, before, limit }) => {
      const timeline = buildActivityTimeline(sqlite, kind, id, {
        ...(depth !== undefined ? { depth } : {}),
        window: { after, before },
        ...(limit !== undefined ? { limit } : {}),
      });
      return jsonResult(timeline);
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
        "updated_after/updated_before time window. Returns `truncated: true` when " +
        "more rows match than `limit` returned (ADR-0007).",
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
      const effLimit = limit ?? DEFAULT_LIST_LIMIT;
      const { rows: items, truncated } = listWithTruncation(effLimit, (probeLimit) =>
        listInbox(sqlite, {
          state,
          ...(sourceType !== undefined ? { sourceType } : {}),
          updated: { after: updatedAfter, before: updatedBefore },
          limit: probeLimit,
        }),
      );
      return jsonResult({ items, truncated });
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
        "are separate write tools). Returns `truncated: true` when more rows match " +
        "than `limit` returned (ADR-0007).",
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
      const effLimit = limit ?? DEFAULT_LIST_LIMIT;
      const { rows: proposals, truncated } = listWithTruncation(effLimit, (probeLimit) =>
        listProposals(sqlite, {
          ...(state ? { state } : {}),
          ...(kind ? { kind } : {}),
          updated: { after: updatedAfter, before: updatedBefore },
          limit: probeLimit,
        }),
      );
      return jsonResult({ proposals, truncated });
    },
  );

  // --- commitment.list: read the commitment ledger by state (ADR-0021). ---
  // Read tool (readOnlyHint: true): outstanding "約束/コミットメント" so a host
  // can surface them as a "やるべきこと" priority signal alongside Slack demand
  // in next-actions / brief. Filter by state and direction.
  server.registerTool(
    "commitment.list",
    {
      title: "List commitments",
      description:
        "List commitments **by urgency**: overdue first (longest overdue leading), " +
        "then upcoming by due date, then undated by recency (Issue #509). Each row " +
        "carries a read-time-derived `overdue`. Optionally filtered by state (open / " +
        "resolved / dismissed), direction (owed_by_me / owed_to_me), the related " +
        "person (matched through the identity graph, so any alias of the same human " +
        "works), `dueBefore`, and `overdue`. Read-only: the visibility half of the " +
        "commitment ledger (ADR-0021); the lifecycle lives in commitment.set. " +
        "Returns `truncated: true` when more rows match than `limit` returned (ADR-0007) " +
        "— but the chase-worthy rows are at the top, so a truncated page keeps them.",
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
        dueBefore: isoDateTime
          .optional()
          .describe("Keep only commitments due before this instant (undated rows excluded)."),
        overdue: z
          .boolean()
          .optional()
          .describe("Keep only overdue commitments (past due and still open)."),
        limit: limitShape.describe(`Max rows (default ${DEFAULT_LIST_LIMIT}).`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({
      state,
      direction,
      person,
      updatedAfter,
      updatedBefore,
      dueBefore,
      overdue,
      limit,
    }) => {
      const effLimit = limit ?? DEFAULT_LIST_LIMIT;
      const { rows: commitments, truncated } = listWithTruncation(effLimit, (probeLimit) =>
        listCommitments(sqlite, {
          ...(state ? { state } : {}),
          ...(direction ? { direction } : {}),
          ...(person !== undefined ? { person } : {}),
          ...(dueBefore !== undefined ? { dueBefore } : {}),
          ...(overdue !== undefined ? { overdue } : {}),
          updated: { after: updatedAfter, before: updatedBefore },
          limit: probeLimit,
        }),
      );
      return jsonResult({ commitments, truncated });
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
        "the person.merge / person.split write tools. Also returns " +
        "`duplicateCandidates`: persons whose display names collide after " +
        "normalization (Issue #443) — merge *candidates* only, never applied " +
        "automatically, since two people really can share a name. Read-only. Returns " +
        "`truncated: true` when more rows match than `limit` returned (ADR-0007).",
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
      const effLimit = limit ?? DEFAULT_LIST_LIMIT;
      const { rows: persons, truncated } = listWithTruncation(effLimit, (probeLimit) =>
        listPersons(sqlite, {
          ...(includeEmpty !== undefined ? { includeEmpty } : {}),
          limit: probeLimit,
        }),
      );
      // Nothing else ever says "there is something to merge", so a ledger can
      // stay split across "Tanaka" and "TANAKA " forever (Issue #443). Surfaced
      // beside the list, applied by nobody but the operator (HITL, ADR-0004).
      return jsonResult({
        persons,
        truncated,
        duplicateCandidates: findDuplicatePersonCandidates(sqlite),
      });
    },
  );
}
