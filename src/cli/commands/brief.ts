/**
 * `suasor brief [--since <dur|iso>] [--until <iso>]` — emit the period bundle
 * (ADR-0017) to stdout for non-interactive / scheduled use.
 *
 * The `brief` MCP tool already bundles the period's material, but only an
 * interactive agent could reach it. This CLI exposes the same `buildBrief`
 * bundle so a cron / CI job can produce a daily / weekly digest without a host
 * LLM in the loop (`--json` for piping into an external summarizer). The bundle
 * is gathered here; summarization stays out-of-process (ADR-0006 ML delegation).
 *
 * Heavy dependencies (config loader, DB layer, query service) are imported
 * lazily inside `execute` to keep cold start light (NFR-PRF-1, docs/design/cli.md).
 */
import { Command, Option } from "clipanion";
import { resolveSince, SINCE_SYNTAX_HINT } from "../../shared/since.ts";

export class BriefCommand extends Command {
  static override paths = [["brief"]];

  static override usage = Command.Usage({
    category: "Retrieval",
    description: "Emit the period brief bundle (tasks/decisions/sources/demand/inbox).",
    details: `
      Bundles the period's material — tasks/decisions updated, sources/Slack
      demand observed, and currently-open inbox — for non-interactive use
      (ADR-0017). The CLI gathers; summarization stays out-of-process — pipe
      --json into your own summarizer (ADR-0006). Default window: the last 24h.
    `,
    examples: [
      ["Last 24h (default)", "suasor brief"],
      ["Last 7 days as JSON", "suasor brief --since 7d --json"],
      ["An explicit window", "suasor brief --since 2026-06-01 --until 2026-06-08"],
    ],
  });

  since = Option.String("--since", {
    description: "Window start: relative (24h / 7d / 2w) or ISO date. Default 24h.",
  });

  until = Option.String("--until", {
    description: "Window end (exclusive): relative (24h / 7d / 2w) or ISO date. Default: now.",
  });

  limit = Option.String("--limit", { description: "Per-section max rows (default 50)." });

  json = Option.Boolean("--json", false, {
    description: "Emit the full bundle as JSON instead of a human-readable summary.",
  });

  override async execute(): Promise<number> {
    const [
      { loadConfig },
      { Store },
      { buildBrief, deriveBriefWarnings },
      { resolveSelfUserIds },
      { emitEmbeddingDisabledHint },
      { deriveSyncFreshness, syncFreshnessInputs },
      { connectorNames },
      { deriveCommitmentScanStaleness, listSyncRuns },
    ] = await Promise.all([
      import("../../config/index.ts"),
      import("../../db/index.ts"),
      import("../../mcp/queries.ts"),
      import("../../connectors/slack.ts"),
      import("../embedding-hint.ts"),
      import("../../connectors/freshness.ts"),
      import("../../connectors/registry.ts"),
      import("../../mcp/queries.ts"),
    ]);

    const now = Date.now();
    const since = resolveSince(this.since ?? "24h", now);
    if (since === null) {
      this.context.stderr.write(`error: --since must be ${SINCE_SYNTAX_HINT}\n`);
      return 1;
    }

    let until = new Date(now).toISOString();
    if (this.until !== undefined) {
      const resolved = resolveSince(this.until, now);
      if (resolved === null) {
        this.context.stderr.write(`error: --until must be ${SINCE_SYNTAX_HINT}\n`);
        return 1;
      }
      until = resolved;
    }

    let limit: number | undefined;
    if (this.limit !== undefined) {
      const parsed = Number(this.limit);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        this.context.stderr.write("error: --limit must be a positive integer\n");
        return 1;
      }
      limit = parsed;
    }

    const config = await loadConfig();
    const dbPath = config.storage.dbPath;
    if (dbPath === null) {
      this.context.stderr.write("error: storage.dbPath is not configured\n");
      return 1;
    }

    // The brief's recall-backed material degrades to FTS when embeddings are
    // disabled — surface that on stderr (Issue #159). Suppressed under --json so
    // a piped bundle stays clean.
    emitEmbeddingDisabledHint(this.context.stderr, config.embedding.backend, this.json);

    // Completeness signals (Issue #189): mark categories empty because they are
    // unconfigured, not because the window is quiet, so a consumer can tell
    // "Slack not connected" from "genuinely nothing". `slackConfigured` keys off
    // `[connectors.slack]` presence, independent of whether a self_user_id is set.
    const store = Store.open({ path: dbPath, embeddingDim: config.embedding.dim });
    try {
      // Ingest freshness (Issue #442): a bundle assembled from a store whose
      // scheduled sync stopped looks exactly like a quiet period. Derived here
      // (read time, `sync_runs`) so `brief` carries the same verdict `doctor`
      // and the MCP `sync.status` tool report.
      const inputs = syncFreshnessInputs(connectorNames(), config);
      const warnings = deriveBriefWarnings({
        slackConfigured: config.connectors.slack !== undefined,
        embeddingBackend: config.embedding.backend,
        syncFreshness: deriveSyncFreshness(
          inputs.enabledConnectors,
          listSyncRuns(store.connection.sqlite),
          inputs,
        ),
        // Material ingested but never scanned for promises (Issue #443) — the
        // commitment ledger is pull-only, so it degrades without any error.
        commitmentScan: deriveCommitmentScanStaleness(store.connection.sqlite),
      });
      const brief = buildBrief(store.connection.sqlite, {
        since,
        until,
        ...(limit !== undefined ? { limit } : {}),
        selfUserIds: resolveSelfUserIds(config.connectors.slack ?? {}),
        warnings,
      });

      if (this.json) {
        this.context.stdout.write(`${JSON.stringify(brief, null, 2)}\n`);
        return 0;
      }

      // Annotate the header with any completeness gaps (e.g. "[⚠ slack_not_configured]").
      const note =
        brief.warnings.length > 0 ? ` [⚠ ${brief.warnings.map((w) => w.key).join(", ")}]` : "";
      this.context.stdout.write(`Brief ${since} → ${until}${note}\n`);
      this.context.stdout.write(
        `  tasks: ${brief.tasks.length}  decisions: ${brief.decisions.length}  ` +
          `sources: ${brief.sources.length}  demand: ${brief.demand.length}  ` +
          `inbox(open): ${brief.inbox.length}  commitments(open): ${brief.commitments.length}\n`,
      );
      // Flag any section the per-section --limit cut off, so a scheduled digest
      // never silently understates a busy day (ADR-0007 "no silent wrong answer").
      const cutSections = (Object.keys(brief.truncated) as (keyof typeof brief.truncated)[]).filter(
        (section) => brief.truncated[section],
      );
      if (cutSections.length > 0) {
        this.context.stdout.write(
          `  [⚠ truncated: ${cutSections.join(", ")}] ` +
            `— narrow --since/--until or raise --limit to see the rest\n`,
        );
      }
      for (const task of brief.tasks) {
        this.context.stdout.write(`  [task:${task.state}] ${task.title}\n`);
      }
      for (const decision of brief.decisions) {
        this.context.stdout.write(`  [decision] ${decision.title}\n`);
      }
      for (const item of brief.demand) {
        const snippet = item.body.replaceAll(/\s+/g, " ").slice(0, 80);
        this.context.stdout.write(`  [demand:${item.kind}] ${snippet}\n`);
      }
      // Overdue first (Issue #509), so a scanned list leads with what to chase.
      for (const c of brief.commitments) {
        const due = c.dueDate === null ? "" : ` (due ${c.dueDate}${c.overdue ? ", overdue" : ""})`;
        this.context.stdout.write(`  [commitment:${c.direction}] ${c.title}${due}\n`);
      }
      return 0;
    } finally {
      store.close();
    }
  }
}
