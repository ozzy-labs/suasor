/**
 * `suasor <connector> sync` — run a read-only connector ingest pass (FR-ING-4,
 * docs/design/cli.md). One command is registered per connector (e.g.
 * `suasor github sync`); the verb is the connector name.
 *
 * The command calls the shared `syncConnector` service — the same code path as
 * the `connector.sync` MCP write tool (Issue #10 追補 D5) — so ingest behaves
 * identically from either entry point.
 *
 * Lazy-import discipline (NFR-PRF-1): the registry's connector-name list is
 * cheap (loads no SDK), so building the command set at registration stays light;
 * the DB layer, config loader, and connector SDK are imported inside `execute`.
 */
import { Command, type CommandClass, Option } from "clipanion";
import { connectorBundledInBinary, connectorNames } from "../../connectors/registry.ts";
import { standaloneGate } from "../build-target.ts";
import { createProgress } from "../progress.ts";

/** A `suasor <name> sync` command bound to one connector name. */
class ConnectorSyncCommand extends Command {
  static connectorName = "";

  json = Option.Boolean("--json", false, {
    description: "Emit the sync outcome (counts + cursor) as JSON.",
  });

  full = Option.Boolean("--full", false, {
    description: "Ignore the saved cursor and re-scan from the beginning.",
  });

  noProgress = Option.Boolean("--no-progress", false, {
    description: "Disable the progress indicator (auto-off when stderr is not a TTY).",
  });

  override async execute(): Promise<number> {
    const name = (this.constructor as typeof ConnectorSyncCommand).connectorName;

    // The heavier connector SDKs are external to the standalone binary
    // (ADR-0010); only the bundled connectors can sync there. Gate the rest with
    // a human-readable error instead of an opaque `Cannot find module` deep in
    // the SDK import.
    if (!connectorBundledInBinary(name)) {
      const gate = standaloneGate(
        `'${name} sync' (the ${name} connector SDK is not shipped in the binary)`,
      );
      if (!gate.ok) {
        this.context.stderr.write(gate.message);
        return 1;
      }
    }

    const [
      { ConfigError, loadConfig },
      { Store },
      { loadConnector, syncConnector },
      { createEmbedder },
      { createExtractor },
    ] = await Promise.all([
      import("../../config/index.ts"),
      import("../../db/index.ts"),
      import("../../connectors/index.ts"),
      import("../../retrieval/embedding/index.ts"),
      import("../../extraction/index.ts"),
    ]);

    // `loadConfig` validates each `[connectors.<name>]` slice against the
    // connector's schema (#162), so a typo / invalid value fails fast here.
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

    const slice = config.connectors[name] ?? {};
    let connector: Awaited<ReturnType<typeof loadConnector>>;
    try {
      connector = await loadConnector(name, slice);
    } catch (cause) {
      this.context.stderr.write(
        `error: ${cause instanceof Error ? cause.message : String(cause)}\n`,
      );
      return 1;
    }

    // Embedder from the [embedding] config (null when disabled). When enabled,
    // ingest (re)populates vec0 with the same model recall queries with
    // (ADR-0005/0006); embedding failures are surfaced as a warning (stderr) and
    // never fail the ingest — FTS still reflects the data.
    const embedder = createEmbedder(config.embedding);

    // Extractor from [extraction] (null when disabled). When enabled, Office/PDF
    // bodies are converted to text at ingest (best-effort, ADR-0024); failures
    // are surfaced as a warning and never fail the ingest (name-only fallback).
    const extractor = createExtractor(config.extraction);

    // Indeterminate progress on stderr while the stream drains (TTY-gated; a
    // no-op in CI / pipes so stdout/--json stay clean). opshub ADR-0026 parity.
    const progress = createProgress(
      this.context.stderr,
      `${name} sync`,
      this.noProgress ? false : undefined,
    );

    const store = Store.open({ path: dbPath, embeddingDim: config.embedding.dim });
    try {
      const outcome = await syncConnector(store, connector, {
        ...(this.full ? { cursor: null } : {}),
        embedder,
        extractor,
        extractionMaxBytes: config.extraction.maxBytes,
        onProgress: () => progress.tick(),
        onWarn: (message) => {
          progress.finish();
          this.context.stderr.write(`warning: ${name}: ${message}\n`);
        },
        onEmbedError: (error) =>
          this.context.stderr.write(`warning: ${name} embedding skipped: ${error.message}\n`),
        onExtractError: (error) =>
          this.context.stderr.write(`warning: ${name} extraction skipped: ${error.message}\n`),
      });
      progress.finish();

      if (this.json) {
        this.context.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
        // A partial failure (e.g. one Slack workspace failed, ADR-0014) keeps the
        // records it did collect but exits non-zero so cron / CI can gate on it
        // (ADR-0027 exit-code parity, #166).
        return outcome.partialFailure ? 1 : 0;
      }

      const embedNote = embedder ? `, ${outcome.embedded} embedded` : "";
      const extractNote = extractor ? `, ${outcome.extracted} extracted` : "";
      this.context.stdout.write(
        `${name} sync: ${outcome.observed} observed, ${outcome.updated} updated, ` +
          `${outcome.unchanged} unchanged${embedNote}${extractNote}.\n`,
      );
      // Per-sub-unit summary lines (e.g. one per Slack workspace, ADR-0014): the
      // breakdown that makes a partial failure legible (which workspace failed).
      for (const line of outcome.summaryLines ?? []) {
        this.context.stdout.write(`${name}: ${line}\n`);
      }
      // Partial failure → non-zero exit (the counts above still reflect what was
      // collected) so a per-workspace failure is not hidden behind exit 0 (#166).
      if (outcome.partialFailure) {
        this.context.stderr.write(
          `error: ${name} sync: one or more workspaces failed (see summary above)\n`,
        );
        return 1;
      }
      return 0;
    } catch (cause) {
      progress.finish();
      this.context.stderr.write(
        `error: ${name} sync failed: ${cause instanceof Error ? cause.message : String(cause)}\n`,
      );
      return 1;
    } finally {
      store.close();
    }
  }
}

/**
 * Build a concrete `suasor <name> sync` command class for one connector. A
 * distinct subclass per connector lets clipanion register static paths while
 * the connector set stays data-driven (from the registry).
 */
function makeConnectorSyncCommand(name: string): CommandClass {
  const Sub = class extends ConnectorSyncCommand {
    static override paths = [[name, "sync"]];
    static override connectorName = name;
    static override usage = Command.Usage({
      category: "Ingest",
      description: `Ingest sources from ${name} (read-only).`,
      details: `
        Runs a read-only ${name} ingest pass: observed sources are appended as
        events and folded into the local projections (ADR-0002/0007). Re-runs
        are incremental — unchanged sources are skipped via fingerprint/cursor
        delta detection (FR-ING-3). Use --full to ignore the saved cursor.
      `,
      examples: [
        [`Ingest from ${name}`, `suasor ${name} sync`],
        [`Re-scan everything as JSON`, `suasor ${name} sync --full --json`],
      ],
    });
  };
  // Stable class name for diagnostics (clipanion uses paths, not the name).
  Object.defineProperty(Sub, "name", { value: `${name}SyncCommand` });
  return Sub;
}

/** Every registered connector's `<name> sync` command (cheap: loads no SDK). */
export function connectorSyncCommands(): CommandClass[] {
  return connectorNames().map(makeConnectorSyncCommand);
}
