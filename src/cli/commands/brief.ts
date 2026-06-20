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

/** `<n><unit>` relative-duration syntax for `--since` (h/d/w). */
const RELATIVE_SINCE = /^(\d+)([hdw])$/;
const UNIT_MS: Record<string, number> = { h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/**
 * Resolve a `--since` value to an ISO 8601 instant: a relative `24h` / `7d` /
 * `2w` (before `nowMs`) or an absolute ISO date / datetime. Returns `null` when
 * it parses as neither. Exported for unit testing.
 */
export function resolveSince(since: string, nowMs: number): string | null {
  const rel = RELATIVE_SINCE.exec(since.trim());
  if (rel) {
    const amount = Number(rel[1]);
    const unit = UNIT_MS[rel[2] as string] as number;
    return new Date(nowMs - amount * unit).toISOString();
  }
  const parsed = Date.parse(since.trim());
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}

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
    description: "Window end (exclusive), ISO date/datetime. Default: now.",
  });

  limit = Option.String("--limit", { description: "Per-section max rows (default 50)." });

  json = Option.Boolean("--json", false, {
    description: "Emit the full bundle as JSON instead of a human-readable summary.",
  });

  override async execute(): Promise<number> {
    const [
      { loadConfig },
      { Store },
      { buildBrief },
      { resolveSelfUserIds },
      { emitEmbeddingDisabledHint },
    ] = await Promise.all([
      import("../../config/index.ts"),
      import("../../db/index.ts"),
      import("../../mcp/queries.ts"),
      import("../../connectors/slack.ts"),
      import("../embedding-hint.ts"),
    ]);

    const now = Date.now();
    const since = resolveSince(this.since ?? "24h", now);
    if (since === null) {
      this.context.stderr.write("error: --since must be a duration (24h / 7d / 2w) or ISO date\n");
      return 1;
    }

    let until = new Date(now).toISOString();
    if (this.until !== undefined) {
      const parsed = Date.parse(this.until.trim());
      if (Number.isNaN(parsed)) {
        this.context.stderr.write("error: --until must be an ISO date/datetime\n");
        return 1;
      }
      until = new Date(parsed).toISOString();
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

    const store = Store.open({ path: dbPath, embeddingDim: config.embedding.dim });
    try {
      const brief = buildBrief(store.connection.sqlite, {
        since,
        until,
        ...(limit !== undefined ? { limit } : {}),
        selfUserIds: resolveSelfUserIds(config.connectors.slack ?? {}),
      });

      if (this.json) {
        this.context.stdout.write(`${JSON.stringify(brief, null, 2)}\n`);
        return 0;
      }

      this.context.stdout.write(`Brief ${since} → ${until}\n`);
      this.context.stdout.write(
        `  tasks: ${brief.tasks.length}  decisions: ${brief.decisions.length}  ` +
          `sources: ${brief.sources.length}  demand: ${brief.demand.length}  ` +
          `inbox(open): ${brief.inbox.length}\n`,
      );
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
      return 0;
    } finally {
      store.close();
    }
  }
}
