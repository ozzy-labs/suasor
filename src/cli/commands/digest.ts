/**
 * `suasor digest [--job <name>] [--dry-run] [--json]` — the proactive push lane
 * (ADR-0040). A cron one-shot (no daemon): it builds one digest per configured
 * standing-consent job (`[digest.jobs]`) — the ADR-0041 priority scorer's top-N
 * plus the brief's completeness warnings — renders it, and pushes it to the job's
 * channel (OS notification / export-sandbox file / Slack DM-to-self).
 *
 * With no configured job it delivers nothing (the "事前同意のない通知なし"
 * boundary, ADR-0040 §2). Content is bundled/rendered only — no in-process
 * summarization (ADR-0006 ML delegation), same as `brief`.
 *
 * Heavy deps (config loader, DB layer, query service, keychain) are imported
 * lazily inside `execute` to keep cold start light (NFR-PRF-1, docs/design/cli.md).
 */
import { Command, Option } from "clipanion";

export class DigestCommand extends Command {
  static override paths = [["digest"]];

  static override usage = Command.Usage({
    category: "Retrieval",
    description: "Push a proactive digest to configured channels (cron one-shot, ADR-0040).",
    details: `
      Builds one digest per configured standing-consent job ([digest.jobs]) — the
      priority scorer's top-N (overdue / demand / due-soon, ADR-0041) plus brief
      completeness warnings — and delivers it to the job's channel (os-notification
      / file / slack-dm). No daemon: schedule it with your OS scheduler (ADR-0027).
      With no configured job, nothing is sent (事前同意のない通知なし, ADR-0040).
      Bundle/render only — summarization stays out of process (ADR-0006).
    `,
    examples: [
      ["Run every configured job (cron)", "suasor digest"],
      ["Run a single named job", "suasor digest --job morning"],
      ["Preview without delivering", "suasor digest --dry-run"],
      ["Machine-readable delivery results", "suasor digest --json"],
    ],
  });

  job = Option.String("--job", { description: "Run only the named [digest.jobs] entry." });

  dryRun = Option.Boolean("--dry-run", false, {
    description: "Render each job's digest to stdout without delivering it.",
  });

  json = Option.Boolean("--json", false, {
    description: "Emit the delivery results (and digest bundles) as JSON.",
  });

  override async execute(): Promise<number> {
    const [
      { loadConfig },
      { Store },
      { deriveBriefWarnings },
      { parseTokenPool, resolveSelfUserIds, SLACK_TOKENS_SECRET },
      { resolveSecret },
      { runDigest },
      { deriveSyncFreshness, syncFreshnessInputs },
      { connectorNames },
      { deriveCommitmentScanStaleness, listSyncRuns },
    ] = await Promise.all([
      import("../../config/index.ts"),
      import("../../db/index.ts"),
      import("../../mcp/queries.ts"),
      import("../../connectors/slack.ts"),
      import("../../connectors/secrets.ts"),
      import("../../digest/run.ts"),
      import("../../connectors/freshness.ts"),
      import("../../connectors/registry.ts"),
      import("../../mcp/queries.ts"),
    ]);

    const config = await loadConfig();
    const dbPath = config.storage.dbPath;
    if (dbPath === null) {
      this.context.stderr.write("error: storage.dbPath is not configured\n");
      return 1;
    }
    const exportDir = config.export.dir;
    if (exportDir === null) {
      this.context.stderr.write("error: export.dir is not configured\n");
      return 1;
    }

    const jobs = config.digest.jobs;
    // Standing-consent boundary (ADR-0040 §2): no configured job ⇒ nothing is
    // ever sent. Report on stderr (cron log) and leave stdout / channels silent.
    if (jobs.length === 0) {
      this.context.stderr.write(
        "no digest jobs configured — nothing sent ([digest.jobs] is empty)\n",
      );
      if (this.json) this.context.stdout.write(`${JSON.stringify({ results: [] }, null, 2)}\n`);
      return 0;
    }
    if (this.job !== undefined && !jobs.some((j) => j.name === this.job)) {
      this.context.stderr.write(`error: no digest job named '${this.job}'\n`);
      return 1;
    }

    const slackCfg = config.connectors.slack ?? {};
    const selfUserIds = resolveSelfUserIds(slackCfg);
    // slack-dm channel (ADR-0042 決定 7): the first pool token + the first
    // configured self id (a DM-to-self needs no workspace disambiguation).
    const resolveSlackSelfId = (): string | null => selfUserIds[0] ?? null;

    const localRoots = (config.connectors.local?.roots as string[] | undefined) ?? [];

    const store = Store.open({ path: dbPath, embeddingDim: config.embedding.dim });
    try {
      // A push digest is the surface where stale ingest does the most damage:
      // it arrives unprompted and reads as "here is what happened", so a frozen
      // sync would quietly report a quiet week (Issue #442).
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
      const results = await runDigest(store.connection.sqlite, jobs, {
        ...(this.job !== undefined ? { jobName: this.job } : {}),
        dryRun: this.dryRun,
        selfUserIds,
        warnings,
        exportDir,
        localRoots,
        resolveSlackTokens: async () =>
          parseTokenPool(await resolveSecret("slack", SLACK_TOKENS_SECRET)),
        resolveSlackSelfId,
      });

      if (this.json) {
        this.context.stdout.write(`${JSON.stringify({ results }, null, 2)}\n`);
        return results.some((r) => r.status === "failed") ? 1 : 0;
      }

      if (this.dryRun) {
        this.context.stdout.write(`Digest dry-run (${results.length}): rendered, not delivered\n`);
        for (const r of results) {
          this.context.stdout.write(`\n--- ${r.job} (${r.channel}) ---\n`);
          const { renderDigestText } = await import("../../digest/content.ts");
          this.context.stdout.write(renderDigestText(r.digest, { title: r.job }));
        }
        return 0;
      }

      this.context.stdout.write(`Digest run (${results.length}):\n`);
      for (const r of results) {
        if (r.status === "delivered") {
          this.context.stdout.write(`  ${r.job}  → ${r.channel}  delivered: ${r.detail ?? ""}\n`);
        } else {
          this.context.stdout.write(
            `  ${r.job}  → ${r.channel}  failed (${r.errorCode ?? "UNKNOWN"}): ${r.error ?? ""}\n`,
          );
        }
      }
      return results.some((r) => r.status === "failed") ? 1 : 0;
    } finally {
      store.close();
    }
  }
}
