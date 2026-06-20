/**
 * `suasor sync` — bulk one-shot ingest across every *enabled* connector
 * (ADR-0027, FR-ING-5/6, docs/design/cli.md). Short-lived and idempotent: it
 * runs one read-only pass per enabled connector in series and exits — no daemon.
 * Periodic execution is delegated to the OS scheduler (docs/guide/scheduling.md).
 *
 * Enabled = a `[connectors.<name>]` slice exists and does not set
 * `enabled = false` — the same rule as `connectors list` / `doctor`. `--connector
 * a,b` narrows the set to the named (enabled, registered) connectors.
 *
 * Continue-on-error (FR-ING-6): one connector's failure does not stop the rest;
 * the run aggregates per-connector results and exits 1 when any connector failed
 * (doctor exit-code parity, so cron / CI can gate on it).
 *
 * Lazy-import discipline (NFR-PRF-1): the registry's name list is cheap (loads no
 * SDK); the DB layer, config loader, and connector SDKs are imported inside
 * `execute` / through the shared bulk-sync service.
 */
import { Command, Option } from "clipanion";
import { connectorNames } from "../../connectors/registry.ts";
import { createProgress } from "../progress.ts";

export class SyncAllCommand extends Command {
  static override paths = [["sync"]];

  static override usage = Command.Usage({
    category: "Ingest",
    description: "Ingest from every enabled connector in one read-only pass.",
    details: `
      Runs one read-only ingest pass for each enabled connector
      ([connectors.<name>] present and not enabled = false) in series, then exits
      (short-lived, idempotent — ADR-0027). Re-runs are incremental
      (fingerprint/cursor delta, FR-ING-3). One connector's failure does not stop
      the others (continue-on-error); the command exits 1 when any connector
      failed so cron / CI can gate on it. Periodic runs are delegated to the OS
      scheduler — see docs/guide/scheduling.md. Use --connector to narrow the set
      and --json for machine-readable output.
    `,
    examples: [
      ["Ingest from all enabled connectors", "suasor sync"],
      ["Only github and slack", "suasor sync --connector github,slack"],
      ["Machine-readable output for cron logs", "suasor sync --json"],
    ],
  });

  connector = Option.String("--connector", {
    description: "Comma-separated connector names to run (default: all enabled).",
  });

  continueOnError = Option.Boolean("--continue-on-error", true, {
    description:
      "Keep going when a connector fails (default on; exit 1 if any failed).",
  });

  json = Option.Boolean("--json", false, {
    description: "Emit the aggregate sync result (per-connector counts/errors) as JSON.",
  });

  full = Option.Boolean("--full", false, {
    description: "Ignore each connector's saved cursor and re-scan from the beginning.",
  });

  noProgress = Option.Boolean("--no-progress", false, {
    description: "Disable the progress indicator (auto-off when stderr is not a TTY).",
  });

  override async execute(): Promise<number> {
    const [
      { loadConfig },
      { Store },
      { loadConnector },
      { runBulkSync, selectEnabledConnectors },
      { createEmbedder },
      { createExtractor },
    ] = await Promise.all([
      import("../../config/index.ts"),
      import("../../db/index.ts"),
      import("../../connectors/index.ts"),
      import("../../connectors/sync-all.ts"),
      import("../../retrieval/embedding/index.ts"),
      import("../../extraction/index.ts"),
    ]);

    const config = await loadConfig();
    const dbPath = config.storage.dbPath;
    if (dbPath === null) {
      this.context.stderr.write("error: storage.dbPath is not configured\n");
      return 1;
    }

    // Enabled connectors (registry order), then narrow by --connector if given.
    let names = selectEnabledConnectors(connectorNames(), config.connectors);
    if (this.connector !== undefined) {
      const requested = new Set(
        this.connector
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      );
      const enabledSet = new Set(names);
      const unknown = [...requested].filter((n) => !enabledSet.has(n));
      if (unknown.length > 0) {
        this.context.stderr.write(
          `error: connector(s) not enabled or not registered: ${unknown.join(", ")}\n`,
        );
        return 1;
      }
      names = names.filter((n) => requested.has(n));
    }

    if (names.length === 0) {
      const detail =
        this.connector !== undefined
          ? "no matching enabled connectors"
          : "no connectors enabled (add a [connectors.<name>] section)";
      if (this.json) {
        this.context.stdout.write(
          `${JSON.stringify({ results: [], succeeded: 0, failed: 0 }, null, 2)}\n`,
        );
      } else {
        this.context.stdout.write(`sync: ${detail}.\n`);
      }
      return 0;
    }

    // Embedder/extractor from config (null when disabled), shared across the run
    // — same best-effort degrade as single-connector sync (ADR-0005/0006/0024).
    const embedder = createEmbedder(config.embedding);
    const extractor = createExtractor(config.extraction);

    const progress = createProgress(
      this.context.stderr,
      "sync",
      this.noProgress ? false : undefined,
    );

    const store = Store.open({ path: dbPath, embeddingDim: config.embedding.dim });
    try {
      const result = await runBulkSync(store, {
        names,
        connectors: config.connectors,
        loadConnector,
        syncOptions: {
          ...(this.full ? { cursor: null } : {}),
          embedder,
          extractor,
          extractionMaxBytes: config.extraction.maxBytes,
          onProgress: () => progress.tick(),
          onWarn: (message) => {
            progress.finish();
            this.context.stderr.write(`warning: ${message}\n`);
          },
          onEmbedError: (error) =>
            this.context.stderr.write(`warning: embedding skipped: ${error.message}\n`),
          onExtractError: (error) =>
            this.context.stderr.write(`warning: extraction skipped: ${error.message}\n`),
        },
        onConnectorStart: () => progress.tick(),
        onConnectorError: (connector, error) => {
          progress.finish();
          this.context.stderr.write(`error: ${connector} sync failed: ${error.message}\n`);
        },
      });
      progress.finish();

      if (this.json) {
        this.context.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return result.failed > 0 ? 1 : 0;
      }

      for (const entry of result.results) {
        if (entry.ok && entry.outcome) {
          const o = entry.outcome;
          const embedNote = embedder ? `, ${o.embedded} embedded` : "";
          const extractNote = extractor ? `, ${o.extracted} extracted` : "";
          this.context.stdout.write(
            `${entry.connector}: ${o.observed} observed, ${o.updated} updated, ` +
              `${o.unchanged} unchanged${embedNote}${extractNote}.\n`,
          );
        } else {
          this.context.stdout.write(`${entry.connector}: failed (${entry.error}).\n`);
        }
      }
      this.context.stdout.write(
        `sync: ${result.succeeded} succeeded, ${result.failed} failed ` +
          `(${result.results.length} connector(s)).\n`,
      );
      return result.failed > 0 ? 1 : 0;
    } finally {
      store.close();
    }
  }
}
