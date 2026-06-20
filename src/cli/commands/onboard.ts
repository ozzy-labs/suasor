/**
 * `suasor onboard` — interactive connector setup wizard (ADR-0029, Issue #160).
 *
 * Orchestrates the correct setup order so the user doesn't have to wire it by
 * hand: select connector(s) → store each token in the keychain (reusing
 * `storeSecret`, the `auth set` path) → run `auth test` (reusing `AUTH_SPECS`)
 * → **append the `[connectors.X]` slice to config.toml** (the structural fix for
 * the "token stored but sync stays silent" gap, ADR-0029) → first `suasor sync`
 * → print an OS scheduler template (ADR-0027) → print the MCP registration block
 * (ADR-0004).
 *
 * The wizard is an *orchestrator*: it owns no auth/ingest logic of its own —
 * those come from `AUTH_SPECS` and the shared bulk-sync service — and its only
 * new side effect is the non-destructive config append. Lazy-import discipline
 * (NFR-PRF-1): top-level imports are clipanion + the cheap connector name lists
 * + the pure render helpers; the keychain, config loader, auth probes, and
 * bulk-sync service are imported inside `execute`.
 *
 * Non-interactive / headless safety (ADR-0029 §4): on a non-TTY stdin the wizard
 * never prompts — `--connector` is required, tokens come from stdin / env
 * override, and `--skip-auth` lets env-override (or binary) installs skip the
 * keychain step. `--json` emits a machine-readable step summary.
 */
import { Command, Option } from "clipanion";
import { authConnectorNames } from "../../connectors/auth-specs.ts";
import { connectorNames } from "../../connectors/registry.ts";
import { renderMcpSnippet } from "../onboard/mcp-snippet.ts";
import { renderSchedulerSnippet } from "../onboard/scheduler.ts";

/** One connector's per-step onboarding outcome (for `--json`). */
interface ConnectorReport {
  connector: string;
  authStored: boolean;
  authTest: "ok" | "failed" | "skipped";
  authTestDetail?: string;
  configAppended: boolean;
  /**
   * How the appended `[connectors.X]` slice was produced (ADR-0030, Issue #195):
   * - `"discovery"` — a discovery verb (github repos / google calendars / box
   *   folders) enumerated ids and the rendered block was appended.
   * - `"template"` — the minimal placeholder slice (discovery unavailable: the
   *   connector has no discovery verb, or the probe was skipped / failed).
   * - `"skipped"` — nothing appended (the slice already existed).
   */
  configSource: "discovery" | "template" | "skipped";
  /** Count of ids discovered when `configSource === "discovery"`. */
  discovered?: number;
}

/** Outcome of the per-connector config-slice append (discovery vs template). */
interface ConfigAppendOutcome {
  /** Whether a new slice was written (false = already present). */
  appended: boolean;
  /** How the slice was produced. */
  source: "discovery" | "template" | "skipped";
  /** Discovered id count (only when `source === "discovery"`). */
  discovered?: number;
  /** Probe error message when a discovery verb existed but the probe failed. */
  discoveryError?: string;
  /** The discovery verb name (for the fallback hint), when a probe failed. */
  discoveryVerb?: string;
}

/** The full `--json` report. */
interface OnboardReport {
  connectors: ConnectorReport[];
  synced: boolean;
  syncExitCode: number | null;
  scheduler: string;
}

export class OnboardCommand extends Command {
  static override paths = [["onboard"]];

  static override usage = Command.Usage({
    category: "Setup",
    description: "Interactive wizard: pick connectors, store tokens, wire config, first sync.",
    details: `
      Walks the correct setup order in one command (ADR-0029): select
      connector(s), store each token in the OS keychain (reusing the same path as
      '<connector> auth set'), verify it with 'auth test', **append the
      [connectors.X] slice to config.toml** (enabled = true — the step people
      forget, which leaves 'suasor sync' silently doing nothing), run the first
      'suasor sync', then print an OS scheduler template (cron / launchd /
      systemd) and the MCP registration block.

      The config append is non-destructive: an existing [connectors.X] section
      (including one you set enabled = false) is never rewritten.

      Non-interactive use: on a non-TTY stdin (a pipe / CI) the wizard does not
      prompt — pass --connector, supply tokens via env override
      (SUASOR_CONNECTOR_<NAME>_<SECRET>) with --skip-auth, and use --json for a
      machine-readable summary.
    `,
    examples: [
      ["Interactive setup", "suasor onboard"],
      ["Non-interactive: github + slack", "suasor onboard --connector github,slack --skip-auth"],
      ["Machine-readable summary", "suasor onboard --connector github --json"],
    ],
  });

  connector = Option.String("--connector", {
    description: "Comma-separated connector(s) to set up (required when stdin is not a TTY).",
  });

  skipAuth = Option.Boolean("--skip-auth", false, {
    description: "Skip keychain storage + auth test (tokens come from env override / binary).",
  });

  skipSync = Option.Boolean("--skip-sync", false, {
    description: "Skip the first 'suasor sync' pass.",
  });

  writeCron = Option.Boolean("--write-cron", false, {
    description: "Append the cron line to your crontab (otherwise the template is only printed).",
  });

  json = Option.Boolean("--json", false, {
    description: "Emit a machine-readable per-step summary instead of human-readable output.",
  });

  override async execute(): Promise<number> {
    const stdout = this.context.stdout;
    const stderr = this.context.stderr;

    const interactive = isInteractive(this.context.stdin);

    // 1. Resolve the connector set. The non-TTY guard takes priority when no
    // --connector was given (a pipe / CI cannot prompt for a selection).
    if (this.connector === undefined && !interactive) {
      stderr.write(
        "error: --connector is required when stdin is not a TTY " +
          "(non-interactive setup cannot prompt for the connector selection)\n",
      );
      return 1;
    }

    const selected = this.resolveConnectors();
    if ("error" in selected) {
      stderr.write(`error: ${selected.error}\n`);
      return 1;
    }
    const connectors = selected.connectors;

    // A single non-TTY stdin stream cannot unambiguously carry N tokens, so
    // multi-connector token entry over a pipe is rejected up front (rather than
    // silently draining stdin on the first connector and failing the rest).
    // Use --skip-auth (env override) or onboard one connector at a time.
    if (connectors.length > 1 && !this.skipAuth && !interactive) {
      stderr.write(
        "error: cannot read multiple connector tokens from a single non-TTY stdin; " +
          "use --skip-auth with env overrides (SUASOR_CONNECTOR_<NAME>_<SECRET>) " +
          "or onboard one connector at a time\n",
      );
      return 1;
    }

    const reports: ConnectorReport[] = [];

    // 2-4. Per connector: store token, auth test, append config slice.
    for (const connector of connectors) {
      const report: ConnectorReport = {
        connector,
        authStored: false,
        authTest: "skipped",
        configAppended: false,
        configSource: "skipped",
      };

      if (!this.skipAuth) {
        const stored = await this.storeTokenFor(connector, interactive);
        if (stored === "no-spec") {
          if (!this.json) {
            stdout.write(
              `${connector}: no generic auth verb — set credentials per docs/guide/connectors.md.\n`,
            );
          }
        } else if (stored === "no-token") {
          stderr.write(
            `error: no token provided for ${connector} ` +
              "(pipe it on stdin or use --skip-auth with an env override)\n",
          );
          return 1;
        } else {
          report.authStored = true;
          if (!this.json) stdout.write(`${connector}: token stored in the OS keychain.\n`);
          const test = await this.authTest(connector);
          report.authTest = test.ok ? "ok" : "failed";
          report.authTestDetail = test.detail;
          if (!this.json) {
            stdout.write(
              test.ok
                ? `${connector}: auth test ok — ${test.detail}\n`
                : `${connector}: auth test FAILED — ${test.detail} (token saved; fix and re-run 'auth test')\n`,
            );
          }
        }
      }

      // Config slice append (the structural fix — runs regardless of --skip-auth).
      // For a discovery-capable connector (github repos / google calendars / box
      // folders, ADR-0030) the wizard runs the discovery probe and appends the
      // rendered block (the discovered ids), so onboard lands more than a bare
      // `enabled = true`. Discovery is best-effort: a missing verb / no token /
      // probe failure falls back to the minimal placeholder template (Issue #195).
      const append = await this.appendConfigSlice(connector);
      report.configAppended = append.appended;
      report.configSource = append.appended ? append.source : "skipped";
      if (append.source === "discovery") report.discovered = append.discovered;
      if (!this.json) {
        if (!append.appended) {
          stdout.write(
            `${connector}: [connectors.${connector}] already in config.toml (left untouched).\n`,
          );
        } else if (append.source === "discovery") {
          stdout.write(
            `${connector}: discovered ${append.discovered} item(s); appended [connectors.${connector}] to config.toml.\n`,
          );
        } else {
          stdout.write(
            `${connector}: appended [connectors.${connector}] (enabled = true) to config.toml.\n`,
          );
        }
      }
      // The discovery-fallback reason goes to stderr regardless of --json (it is
      // not part of the machine-readable stdout summary, but the operator should
      // know discovery did not run so the placeholder needs hand-editing).
      if (append.discoveryError) {
        stderr.write(
          `${connector}: discovery skipped (${append.discoveryError}); wrote the placeholder slice — edit it by hand or re-run \`suasor ${connector} ${append.discoveryVerb}\`.\n`,
        );
      }

      reports.push(report);
    }

    // 5. First sync.
    let synced = false;
    let syncExitCode: number | null = null;
    if (!this.skipSync) {
      const result = await this.firstSync(connectors);
      synced = true;
      syncExitCode = result.code;
      if (!this.json) stdout.write(result.summary);
    }

    // 6. Scheduler template.
    const command = invocationCommand();
    const scheduler = renderSchedulerSnippet(process.platform, command);
    if (this.writeCron) {
      const wrote = await this.appendCron(command);
      if (!this.json) {
        stdout.write(wrote ? "Appended the cron line to your crontab.\n" : "");
      }
    }
    if (!this.json) {
      stdout.write(`\nPeriodic sync — ${scheduler.label} (Suasor runs no daemon, ADR-0027):\n`);
      stdout.write(`${scheduler.snippet}\n`);
    }

    // 7. MCP registration snippet.
    if (!this.json) {
      stdout.write(
        "\nRegister the MCP server with your agent host (claude_desktop_config.json):\n",
      );
      stdout.write(`${renderMcpSnippet(command)}\n`);
    }

    if (this.json) {
      const report: OnboardReport = {
        connectors: reports,
        synced,
        syncExitCode,
        scheduler: scheduler.kind,
      };
      stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    }

    // Surface a sync failure via exit code (cron/CI parity) without aborting the
    // wizard's printed guidance.
    return syncExitCode && syncExitCode > 0 ? 1 : 0;
  }

  /** Resolve and validate the requested connector list. */
  private resolveConnectors(): { connectors: string[] } | { error: string } {
    const known = new Set(connectorNames());
    if (this.connector !== undefined) {
      const requested = this.connector
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (requested.length === 0) return { error: "--connector was empty" };
      const unknown = requested.filter((n) => !known.has(n));
      if (unknown.length > 0) {
        return {
          error: `unknown connector(s): ${unknown.join(", ")} (known: ${[...known].join(", ")})`,
        };
      }
      return { connectors: dedupe(requested) };
    }
    // Interactive default: no explicit list yet → caller already gated non-TTY.
    // With no prompt UI wired here, require an explicit --connector for now.
    return { error: "no connector selected (pass --connector <name[,name]>)" };
  }

  /** Read a token from stdin and store it in the keychain. Returns a status tag. */
  private async storeTokenFor(
    connector: string,
    interactive: boolean,
  ): Promise<"stored" | "no-token" | "no-spec"> {
    const { AUTH_SPECS } = await import("../../connectors/auth-specs.ts");
    const spec = AUTH_SPECS[connector];
    if (!spec) return "no-spec";

    if (interactive) {
      this.context.stdout.write(
        `Paste the ${connector} ${spec.secretLabel} and press Enter (input is read from stdin):\n`,
      );
    }
    const token = (await readStdin(this.context.stdin)).trim();
    if (!token) return "no-token";

    const { storeSecret } = await import("../../connectors/secrets.ts");
    await storeSecret(connector, spec.secretName, token);
    return "stored";
  }

  /** Run the connector's `auth test` probe and normalize the outcome. */
  private async authTest(connector: string): Promise<{ ok: boolean; detail: string }> {
    const { AUTH_SPECS } = await import("../../connectors/auth-specs.ts");
    const spec = AUTH_SPECS[connector];
    if (!spec) return { ok: false, detail: "no auth spec" };

    const [{ loadConfig }, { makeSecretResolver }] = await Promise.all([
      import("../../config/index.ts"),
      import("../../connectors/secrets.ts"),
    ]);
    const config = await loadConfig();
    const slice = (config.connectors[connector] ?? {}) as Record<string, unknown>;
    try {
      const report = await spec.test({ secret: makeSecretResolver(connector), config: slice });
      return { ok: true, detail: `${report.principal} (${report.scopes ?? "no scopes reported"})` };
    } catch (cause) {
      return { ok: false, detail: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  /**
   * Append the connector slice to config.toml (non-destructive).
   *
   * When the connector exposes a discovery verb (ADR-0030) the wizard runs the
   * probe and appends the rendered block (the discovered ids); otherwise — or
   * when the probe is unavailable / fails — it appends the minimal placeholder
   * template. The append itself is always non-destructive (an existing
   * `[connectors.X]`, including `enabled = false`, is never rewritten).
   */
  private async appendConfigSlice(connector: string): Promise<ConfigAppendOutcome> {
    const [{ resolveConfigDir }, configAppend, { join }] = await Promise.all([
      import("../../config/index.ts"),
      import("../onboard/config-append.ts"),
      import("node:path"),
    ]);
    const configPath = join(resolveConfigDir(process.env), "config.toml");
    const file = Bun.file(configPath);
    const current = (await file.exists()) ? await file.text() : "";

    // Already present → leave it untouched (no discovery probe needed).
    if (configAppend.hasConnectorSlice(current, connector)) {
      return { appended: false, source: "skipped" };
    }

    // Discovery-capable connector → run the probe and append the rendered block.
    const discovery = await this.discoverConfigBlock(connector);
    if (discovery && "configBlock" in discovery) {
      const result = configAppend.appendConnectorBlock(current, connector, discovery.configBlock);
      if (result.appended) await Bun.write(configPath, result.toml);
      return { appended: result.appended, source: "discovery", discovered: discovery.count };
    }

    // No discovery verb (or the probe failed) → minimal placeholder template.
    const result = configAppend.appendConnectorSlice(current, connector);
    if (result.appended) await Bun.write(configPath, result.toml);
    return {
      appended: result.appended,
      source: "template",
      ...(discovery?.error
        ? { discoveryError: discovery.error, discoveryVerb: discovery.verb }
        : {}),
    };
  }

  /**
   * Run the connector's discovery probe (ADR-0030) and return the rendered
   * `[connectors.X]` block + item count. Returns `null` when the connector has
   * no discovery verb, or `{ error, verb }` when the probe failed (so the caller
   * falls back to the placeholder template and surfaces the reason). Best-effort
   * and read-only; the credential is never echoed.
   */
  private async discoverConfigBlock(
    connector: string,
  ): Promise<
    { configBlock: readonly string[]; count: number } | { error: string; verb: string } | null
  > {
    const { DISCOVERY_SPECS } = await import("../../connectors/discovery-specs.ts");
    const spec = DISCOVERY_SPECS[connector];
    if (!spec) return null;

    const [{ loadConfig }, { makeSecretResolver }] = await Promise.all([
      import("../../config/index.ts"),
      import("../../connectors/secrets.ts"),
    ]);
    const config = await loadConfig();
    const slice = (config.connectors[connector] ?? {}) as Record<string, unknown>;
    try {
      const result = await spec.discover({
        secret: makeSecretResolver(connector),
        config: slice,
      });
      return { configBlock: result.configBlock, count: result.items.length };
    } catch (cause) {
      return { error: cause instanceof Error ? cause.message : String(cause), verb: spec.verb };
    }
  }

  /** Run the first `suasor sync` over the selected connectors via the shared service. */
  private async firstSync(connectors: string[]): Promise<{ code: number; summary: string }> {
    const [{ loadConfig }, { Store }, { loadConnector }, { runBulkSync, selectEnabledConnectors }] =
      await Promise.all([
        import("../../config/index.ts"),
        import("../../db/index.ts"),
        import("../../connectors/index.ts"),
        import("../../connectors/sync-all.ts"),
      ]);

    const config = await loadConfig();
    const dbPath = config.storage.dbPath;
    if (dbPath === null) {
      return { code: 1, summary: "sync: storage.dbPath is not configured.\n" };
    }
    // Only the connectors we just enabled (intersect with the enabled set so an
    // append-skipped, enabled=false slice is honored).
    const enabled = new Set(selectEnabledConnectors(connectorNames(), config.connectors));
    const names = connectors.filter((n) => enabled.has(n));
    if (names.length === 0) {
      return { code: 0, summary: "sync: no enabled connectors to ingest (skipped first sync).\n" };
    }

    const store = Store.open({ path: dbPath, embeddingDim: config.embedding.dim });
    try {
      const result = await runBulkSync(store, {
        names,
        connectors: config.connectors,
        loadConnector,
        continueOnError: true,
        syncOptions: {},
      });
      const lines = result.results.map((entry) =>
        entry.ok && entry.outcome
          ? `${entry.connector}: ${entry.outcome.observed} observed, ${entry.outcome.updated} updated.`
          : `${entry.connector}: failed (${entry.error}).`,
      );
      const summary = `${lines.join("\n")}\nsync: ${result.succeeded} succeeded, ${result.failed} failed.\n`;
      return { code: result.failed > 0 ? 1 : 0, summary };
    } finally {
      store.close();
    }
  }

  /** Append the cron line to the user's crontab (best-effort). Returns success. */
  private async appendCron(command: string): Promise<boolean> {
    try {
      const existing = await new Response(
        Bun.spawn(["crontab", "-l"], { stderr: "ignore" }).stdout,
      ).text();
      const line = `15 * * * * ${command} sync --json >> "$HOME/.local/state/suasor/sync.log" 2>&1`;
      if (existing.includes(`${command} sync`)) return false; // already scheduled
      const next = `${existing.replace(/\s*$/, "")}\n${line}\n`;
      const proc = Bun.spawn(["crontab", "-"], { stdin: "pipe" });
      proc.stdin.write(next);
      await proc.stdin.end();
      await proc.exited;
      return proc.exitCode === 0;
    } catch {
      this.context.stderr.write("warning: could not append to crontab (is `crontab` installed?)\n");
      return false;
    }
  }
}

/** Whether stdin is an interactive TTY (so prompts are safe to show). */
function isInteractive(stdin: unknown): boolean {
  // clipanion's context.stdin is the real process.stdin in production; tests
  // inject an async iterable (no isTTY) which correctly reads as non-interactive.
  return Boolean((stdin as { isTTY?: boolean } | undefined)?.isTTY);
}

/** Best-effort `suasor` invocation string for the printed templates. */
function invocationCommand(): string {
  // A global install exposes `suasor` on PATH; from source it's `bun run
  // src/index.ts`. We can't know the user's channel, so prefer the published
  // name (the templates are guidance the user adapts).
  return "suasor";
}

/** Remove duplicates while preserving order. */
function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

/** Read all of stdin to a string. */
async function readStdin(stdin: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Exported for tests: the connectors that expose the generic auth verbs. */
export const ONBOARD_AUTH_CONNECTORS = authConnectorNames();
