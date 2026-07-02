/**
 * `suasor sync` — bulk one-shot ingest across every *enabled* connector
 * (ADR-0027, FR-ING-5/6, docs/design/cli.md). Short-lived and idempotent: it runs
 * one read-only pass per enabled connector and exits — no daemon. Periodic
 * execution is delegated to the OS scheduler (docs/guide/scheduling.md).
 *
 * Enabled = a `[connectors.<name>]` slice exists and does not set
 * `enabled = false` — the same rule as `connectors list` / `doctor`. `--connector
 * a,b` narrows the set to the named (enabled, registered) connectors.
 *
 * Continue-on-error (FR-ING-6): one connector's failure does not stop the rest;
 * the run aggregates per-connector results and exits 1 when any connector failed
 * (doctor exit-code parity, so cron / CI can gate on it). On this default path
 * connectors sync concurrently in a bounded pool (`--concurrency`, default 4 —
 * Issue #269); `--no-continue-on-error` runs them serially, fail-fast.
 *
 * Lazy-import discipline (NFR-PRF-1): the registry's name list is cheap (loads no
 * SDK); the DB layer, config loader, and connector SDKs are imported inside
 * `execute` / through the shared bulk-sync service.
 */
import { Command, Option } from "clipanion";
import { connectorBundledInBinary, connectorNames } from "../../connectors/registry.ts";
import { BINARY_SCOPE_DOC, currentBuildIsBinary } from "../build-target.ts";
import { docsUrl } from "../doc-ref.ts";
import { createProgress } from "../progress.ts";

export class SyncAllCommand extends Command {
  static override paths = [["sync"]];

  static override usage = Command.Usage({
    category: "Ingest",
    description: "Ingest from every enabled connector in one read-only pass.",
    details: `
      Runs one read-only ingest pass for each enabled connector
      ([connectors.<name>] present and not enabled = false), then exits
      (short-lived, idempotent — ADR-0027). Re-runs are incremental
      (fingerprint/cursor delta, FR-ING-3). One connector's failure does not stop
      the others (continue-on-error); the command exits 1 when any connector
      failed so cron / CI can gate on it (use --no-continue-on-error for a serial
      fail-fast run). On the continue-on-error path connectors sync concurrently in
      a bounded pool (default 4 — each hits a different API host / rate-limit
      bucket); --concurrency tunes it (>8 warns but is not capped; per-resource work
      inside a connector stays serial). Periodic runs are delegated to the OS
      scheduler — see ${docsUrl("guide/scheduling.md")}. Use --connector to narrow the set
      and --json for machine-readable output.
    `,
    examples: [
      ["Ingest from all enabled connectors", "suasor sync"],
      ["Only github and slack", "suasor sync --connector github,slack"],
      ["Cap concurrent connectors at 2", "suasor sync --concurrency 2"],
      ["Machine-readable output for cron logs", "suasor sync --json"],
    ],
  });

  connector = Option.String("--connector", {
    description: "Comma-separated connector names to run (default: all enabled).",
  });

  continueOnError = Option.Boolean("--continue-on-error", true, {
    description: "Keep going when a connector fails (default on; exit 1 if any failed).",
  });

  concurrency = Option.String("--concurrency", {
    description:
      "Max connectors syncing at once (default 4; >8 warns; ignored with --no-continue-on-error).",
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
      { ConfigError, loadConfig },
      { Store },
      { loadConnector },
      { runBulkSync, selectEnabledConnectors },
      { createEmbedderResolved },
      { createExtractor },
    ] = await Promise.all([
      import("../../config/index.ts"),
      import("../../db/index.ts"),
      import("../../connectors/index.ts"),
      import("../../connectors/sync-all.ts"),
      import("../../retrieval/embedding/index.ts"),
      import("../../extraction/index.ts"),
    ]);

    // `loadConfig` validates each `[connectors.<name>]` slice against the
    // connector's schema (#162); a typo / invalid value fails fast for the whole
    // run (before any connector syncs), independent of `--continue-on-error`.
    let config: Awaited<ReturnType<typeof loadConfig>>;
    try {
      config = await loadConfig();
    } catch (cause) {
      if (cause instanceof ConfigError) {
        this.context.stderr.write(`error: ${cause.message}\n`);
        return 1;
      }
      throw cause;
    }
    const dbPath = config.storage.dbPath;
    if (dbPath === null) {
      this.context.stderr.write("error: storage.dbPath is not configured\n");
      return 1;
    }

    // Parse --concurrency up front so an invalid value fails fast (a string flag
    // keeps clipanion from coercing; we want a clear error, not NaN downstream).
    let concurrency: number | undefined;
    if (this.concurrency !== undefined) {
      const parsed = Number.parseInt(this.concurrency, 10);
      if (!Number.isInteger(parsed) || parsed < 1) {
        this.context.stderr.write(
          `error: --concurrency must be a positive integer (got "${this.concurrency}")\n`,
        );
        return 1;
      }
      concurrency = parsed;
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

    // In the standalone binary the heavier connector SDKs are external
    // (ADR-0010): drop those connectors up front (with a human-readable note)
    // rather than letting each fail with an opaque `Cannot find module`. The
    // bundled connectors (github / local) still run.
    if (currentBuildIsBinary()) {
      const unsupported = names.filter((n) => !connectorBundledInBinary(n));
      if (unsupported.length > 0) {
        this.context.stderr.write(
          `warning: skipping ${unsupported.join(", ")}: not available in the standalone binary ` +
            `(SDK not shipped) — use npm (Bun) or Docker. See ${BINARY_SCOPE_DOC}\n`,
        );
        names = names.filter((n) => connectorBundledInBinary(n));
      }
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
    const embedder = await createEmbedderResolved(config.embedding);
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
        continueOnError: this.continueOnError,
        ...(concurrency !== undefined ? { concurrency } : {}),
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
        if (entry.outcome) {
          // A clean success OR a partial failure (records were collected, but one
          // sub-unit failed, ADR-0014 / #166): print the counts either way, then
          // the per-sub-unit summary, then a trailing `(partial failure)` marker
          // when the entry is marked failed so the exit-1 reason is legible.
          const o = entry.outcome;
          const embedNote = embedder ? `, ${o.embedded} embedded` : "";
          const extractNote = extractor ? `, ${o.extracted} extracted` : "";
          const partialNote = entry.ok ? "" : " (partial failure)";
          this.context.stdout.write(
            `${entry.connector}: ${o.observed} observed, ${o.updated} updated, ` +
              `${o.unchanged} unchanged${embedNote}${extractNote}${partialNote}.\n`,
          );
          for (const line of o.summaryLines ?? []) {
            this.context.stdout.write(`${entry.connector}: ${line}\n`);
          }
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

/**
 * `suasor sync status [--json]` — per-connector freshness view (ADR-0033).
 *
 * Reads the `sync_runs` projection (folded from SyncRunStarted / SyncRunEnded)
 * and shows each connector's last sync time, counts, and outcome so an operator
 * can tell whether the local data is stale or a recent run failed — without
 * digging through the OS scheduler's logs (scheduling is delegated, ADR-0027).
 *
 * Read-only (autonomous OK, ADR-0004). Enabled connectors that have never synced
 * are listed as "never synced" so a missing connector is not silently absent.
 * `--json` emits a machine-readable array for cron monitoring (ADR-0027 parity).
 */
export class SyncStatusCommand extends Command {
  static override paths = [["sync", "status"]];

  static override usage = Command.Usage({
    category: "Ingest",
    description: "Show per-connector sync freshness (last sync time / counts / outcome).",
    details: `
      Shows each connector's latest sync run (ADR-0033): when it last synced, how
      many sources it observed / updated / left unchanged, and whether the run
      succeeded, partially failed, or errored. Folded from the sync run history
      events, so it reflects failed runs too (a connector that throws still
      records an errored run) — something the resume cursor alone never surfaced.

      Next run is not shown: periodic execution is delegated to the OS scheduler
      (ADR-0027), so Suasor derives freshness from the last run instead. Use
      --json for machine-readable output (cron monitoring).

      Connectors that are enabled but have never synced are listed as
      "never synced" so a missing connector is not silently absent.
    `,
    examples: [
      ["Show sync freshness", "suasor sync status"],
      ["Machine-readable output", "suasor sync status --json"],
    ],
  });

  json = Option.Boolean("--json", false, {
    description: "Emit the per-connector freshness rows as JSON.",
  });

  override async execute(): Promise<number> {
    const [{ loadConfig }, { Store }, { listSyncRuns }] = await Promise.all([
      import("../../config/index.ts"),
      import("../../db/index.ts"),
      import("../../mcp/queries.ts"),
    ]);

    const config = await loadConfig();
    const dbPath = config.storage.dbPath;
    if (dbPath === null) {
      this.context.stderr.write("error: storage.dbPath is not configured\n");
      return 1;
    }

    // Enabled connectors (registry order) so a connector that is configured but
    // has never synced is surfaced as "never synced" rather than omitted.
    const { selectEnabledConnectors } = await import("../../connectors/sync-all.ts");
    const enabled = selectEnabledConnectors(connectorNames(), config.connectors);

    const store = Store.open({ path: dbPath, embeddingDim: config.embedding.dim });
    try {
      const runs = listSyncRuns(store.connection.sqlite);
      const byConnector = new Map(runs.map((r) => [r.connector, r]));

      // Union of enabled connectors and any connector that has run history (so a
      // since-disabled connector's last run is still visible), enabled first.
      const names = [
        ...enabled,
        ...runs.map((r) => r.connector).filter((c) => !enabled.includes(c)),
      ];

      if (this.json) {
        const rows = names.map((connector) => {
          const r = byConnector.get(connector);
          return r
            ? {
                connector,
                status: r.status,
                startedAt: r.startedAt,
                endedAt: r.endedAt,
                observed: r.observed,
                updated: r.updated,
                unchanged: r.unchanged,
                durationMs: r.durationMs,
                lastError: r.lastError,
              }
            : { connector, status: "never_synced" };
        });
        this.context.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
        return 0;
      }

      if (names.length === 0) {
        this.context.stdout.write("sync status: no connectors enabled.\n");
        return 0;
      }

      for (const connector of names) {
        const r = byConnector.get(connector);
        if (r === undefined) {
          this.context.stdout.write(`${connector}: never synced\n`);
          continue;
        }
        const when = r.endedAt ?? `${r.startedAt} (running)`;
        const counts = `${r.observed} observed, ${r.updated} updated, ${r.unchanged} unchanged`;
        const dur = r.durationMs !== null ? `, ${r.durationMs}ms` : "";
        const errNote = r.status === "error" && r.lastError ? ` — ${r.lastError}` : "";
        this.context.stdout.write(
          `${connector}: ${r.status} — ${when} (${counts}${dur})${errNote}\n`,
        );
      }
      return 0;
    } finally {
      store.close();
    }
  }
}
