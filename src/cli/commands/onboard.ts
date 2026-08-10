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
 * + the pure render / secret-entry helpers; the keychain, config loader, auth
 * probes, and bulk-sync service are imported inside `execute`.
 *
 * Non-interactive / headless safety (ADR-0029 §4): on a non-TTY stdin the wizard
 * never prompts — `--connector` is required, tokens come from stdin / env
 * override, and `--skip-auth` lets env-override (or binary) installs skip the
 * keychain step. `--json` emits a machine-readable step summary.
 */
import { Command, Option } from "clipanion";
import { authConnectorNames } from "../../connectors/auth-specs.ts";
import type { AccountSlice } from "../../connectors/multi-account.ts";
import { connectorBundledInBinary, connectorNames } from "../../connectors/registry.ts";
import type { KeychainBackend } from "../../connectors/secrets.ts";
import { SuasorCommand } from "../base-command.ts";
import { BINARY_SCOPE_DOC, currentBuildIsBinary, standaloneGate } from "../build-target.ts";
import { noPerAccountConfigMessage } from "../connector-account.ts";
import { docsUrl } from "../doc-ref.ts";
import { loadOnboardBridge, onboardBridgeNames } from "../onboard/bridges.ts";
import {
  DOCKER_RUN_COMMAND,
  detectInvocationChannel,
  invocationNote,
} from "../onboard/invocation.ts";
import {
  mcpInvocationNote,
  renderMcpSnippet,
  resolveMcpInvocation,
} from "../onboard/mcp-snippet.ts";
import {
  type EmbeddingRecap,
  type RecapConnector,
  recapHasFailure,
  renderRecap,
} from "../onboard/recap.ts";
import {
  type DigestJobRef,
  renderDigestSchedulerLines,
  renderSchedulerSnippet,
} from "../onboard/scheduler.ts";
import { renderConnectorMenu, resolveSelection } from "../onboard/select.ts";
import { createProgress } from "../progress.ts";
import { readSecretLine } from "../read-secret.ts";

/** One connector's per-step onboarding outcome (for `--json`). */
interface ConnectorReport {
  connector: string;
  /**
   * The named account this run configured (`--account`, ADR-0050 / Issue #538),
   * absent for an ordinary flat-slice run. Additive: a single-account onboard's
   * JSON shape is unchanged.
   */
  account?: string;
  /**
   * What happened to the account that was already syncing as flat
   * `[connectors.<name>]` keys, when a *named* account was added next to it
   * (account mode only — see {@link AccountAppendOutcome.defaultAccount}).
   */
  defaultAccount?: DefaultAccountOutcome;
  /**
   * Which auth path the connector uses (Issue #384; backward-compatible additive
   * field, defaults to `"generic"`):
   * - `"generic"` — the data-driven `<connector> auth set` / `auth test` verbs
   *   (AUTH_SPECS): onboard stores the token and runs the probe itself.
   * - `"connector-specific"` — the connector maintains its own auth flow (slack's
   *   `slack auth set` / `slack conversations`, ADR-0011/0014), which onboard
   *   cannot complete for the user; it prints that connector's own next steps
   *   instead of the generic guidance.
   */
  authFlow: "generic" | "connector-specific";
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

/**
 * What the wizard did about the flat keys of a config that was already syncing,
 * when `--account <name>` adds the first *named* account beside them (ADR-0050
 * 決定 2 / 決定 3 — an `accounts` table demotes the flat keys to inheritance
 * defaults, so the account that was there stops being ingested).
 *
 * The two live values are deliberately the two confidence levels doctor's
 * `connectors.accounts` check already draws (ADR-0050 決定 5):
 * - `preserved` — a credential for the unnamed default account resolves, which
 *   is *evidence* that account really was ingesting, so the wizard writes
 *   `[connectors.<name>.accounts.default]` and keeps it ingesting;
 * - `unknown` — no such credential, and nothing else distinguishes "had a
 *   default account" from "never had one". The wizard states the rule and writes
 *   nothing, because inventing that distinction is exactly the guess doctor
 *   refuses to make — and an unwanted `accounts.default` would be a configured
 *   account with no credential, i.e. a warned skip and a non-zero exit on every
 *   sync (ADR-0050 決定 4).
 */
type DefaultAccountOutcome = "preserved" | "unknown" | "not-applicable";

/** Outcome of the per-account config-table append (account mode). */
interface AccountAppendOutcome extends ConfigAppendOutcome {
  /** What happened to the previously-flat default account. */
  defaultAccount: DefaultAccountOutcome;
  /** Whether the connector's own `[connectors.<name>]` slice had to be created first. */
  baseAppended: boolean;
}

/**
 * Per-connector facts `--account` mode resolves **before** anything is written.
 *
 * Read up front because every one of them changes after the first append: once
 * the wizard writes the account table, "did this config declare accounts before
 * I touched it" can no longer be answered, and that is the question that decides
 * whether an existing account is about to stop syncing.
 */
interface AccountPlan {
  /** The config already carries a `[connectors.<name>]` entry. */
  readonly connectorConfigured: boolean;
  /** The config already declares an `accounts` table for this connector. */
  readonly accountsDeclared: boolean;
  /**
   * The config already declares **this** account.
   *
   * Read from the parsed config, not from the header line scan, because the two
   * disagree on the spellings TOML allows: `[connectors.box.accounts."work"]`
   * declares account `work` and the scan does not see it. Appending on top of
   * that would leave two tables for one account, and whichever the parser then
   * resolves is a value the operator did not choose.
   */
  readonly accountDeclared: boolean;
}

/** The full `--json` report. */
interface OnboardReport {
  connectors: ConnectorReport[];
  synced: boolean;
  syncExitCode: number | null;
  scheduler: string;
  /** Names of configured [digest.jobs] surfaced in the scheduler step (ADR-0040). */
  digestJobs: string[];
  /**
   * What the first sync left without a vector (Issue #547), or `null` when every
   * ingested source was embedded (or nothing was ingested / the sync was
   * skipped). The machine-readable counterpart of the recap's `embeddings:` line
   * — `--json` suppresses the recap, and this gap must not be human-only.
   */
  embeddings: EmbeddingRecap | null;
}

export class OnboardCommand extends SuasorCommand {
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
      systemd) — including ready-to-paste digest lines for any configured
      [digest.jobs] (standing consent, ADR-0040) — and the MCP registration
      block.

      The config append is non-destructive: an existing [connectors.X] section
      (including one you set enabled = false) is never rewritten.

      A second account (personal + work mail / calendar / files) is added with
      --account <name>, on the connectors whose manifest declares per-account
      configuration (ADR-0050; anything else is refused by name): the token is
      stored under that account's own keychain name (the same path as
      '<connector> auth set --account'), verified with 'auth test', and appended
      as [connectors.<name>.accounts.<account>]. Because that table demotes the
      connector's flat keys to inheritance defaults, the wizard also writes
      [connectors.<name>.accounts.default] when a credential shows the unnamed
      account was really ingesting — so adding the second account does not
      silently stop the first.

      Non-interactive use: on a non-TTY stdin (a pipe / CI) the wizard does not
      prompt — pass --connector, supply tokens via env override
      (SUASOR_CONNECTOR_<NAME>_<SECRET>) with --skip-auth, and use --json for a
      machine-readable summary.
    `,
    examples: [
      ["Interactive setup", "suasor onboard"],
      ["Non-interactive: github + slack", "suasor onboard --connector github,slack --skip-auth"],
      ["Add a second Google account", "suasor onboard --connector google --account work"],
      ["Machine-readable summary", "suasor onboard --connector github --json"],
    ],
  });

  connector = Option.String("--connector", {
    description: "Comma-separated connector(s) to set up (required when stdin is not a TTY).",
  });

  account = Option.String("--account", {
    description:
      "Configure this named account instead of the connector's flat slice, on connectors with a [connectors.<name>.accounts.<account>] table (ADR-0050) — how a second personal / work account is added.",
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

  writeLaunchd = Option.Boolean("--write-launchd", false, {
    description:
      "Write the launchd agent to ~/Library/LaunchAgents (macOS; prints the load command).",
  });

  writeSystemd = Option.Boolean("--write-systemd", false, {
    description:
      "Write the systemd user service + timer to ~/.config/systemd/user (prints the enable command).",
  });

  json = Option.Boolean("--json", false, {
    description: "Emit a machine-readable per-step summary instead of human-readable output.",
  });

  override async execute(): Promise<number> {
    const stdout = this.context.stdout;
    const stderr = this.context.stderr;

    const interactive = isInteractive(this.context.stdin);

    // 0. Standalone-binary gates (Issue #557). The binary keeps the OS keychain
    // (@napi-rs/keyring) external (ADR-0010), so the wizard's token-storage step
    // — the `auth set` path — would otherwise crash with an opaque
    // `Cannot find module` *after* the user pasted a secret. Gate it up front,
    // before any prompt, and surface the escape hatch (`auth set` gates the
    // same way; the wizard was the one keychain writer left ungated).
    if (!this.skipAuth) {
      const authGate = standaloneGate(
        "'onboard' keychain token storage (the OS keychain is not available in the binary)",
        {
          hint:
            "re-run with --skip-auth and set each secret via its env override " +
            "(SUASOR_CONNECTOR_<NAME>_<SECRET>, e.g. SUASOR_CONNECTOR_GITHUB_TOKEN=<value>)",
        },
      );
      if (!authGate.ok) {
        stderr.write(authGate.message);
        return 1;
      }
    }

    // 1. Resolve the connector set. With --connector we validate the explicit
    // list; without it we prompt interactively on a TTY (ADR-0029 §2) and keep
    // the explicit "--connector required" error on a non-TTY (ADR-0029 §4).
    const selected =
      this.connector === undefined ? await this.promptConnectors() : this.resolveConnectors();
    if ("error" in selected) {
      stderr.write(`error: ${selected.error}\n`);
      return 1;
    }
    const connectors = selected.connectors;

    // 1a. SDK gate (Issue #557): the connectors kept external to the binary
    // (slack / ms-graph / google / box / web) cannot auth-test or sync there at
    // all, so onboarding one would configure a connector this build can never
    // run. Refused by name (the interactive menu already filters them out; this
    // catches the explicit `--connector` path).
    const external = connectors.filter((name) => !connectorBundledInBinary(name));
    if (external.length > 0) {
      const sdkGate = standaloneGate(
        `'onboard' for ${external.join(", ")} (the connector SDK is not shipped in the binary)`,
      );
      if (!sdkGate.ok) {
        stderr.write(sdkGate.message);
        return 1;
      }
    }

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

    // 1b. Account mode (--account, ADR-0050 / Issue #538). Everything that can
    // refuse the run is resolved here, before a single token is stored: which
    // connectors accept a named account, whether the name is usable, and — per
    // connector — whether an account is about to be silently demoted. Doing it
    // up front is what makes the refusals cheap to obey (nothing to undo) and
    // the demotion detectable at all (it is unanswerable after the first write).
    const accountPlans = new Map<string, AccountPlan>();
    if (this.account !== undefined) {
      const prepared = await this.prepareAccountMode(connectors, this.account);
      if ("error" in prepared) {
        stderr.write(`error: ${prepared.error}\n`);
        return 1;
      }
      for (const [name, plan] of prepared.plans) accountPlans.set(name, plan);
    }

    const reports: ConnectorReport[] = [];
    // Connectors whose discovery probe was attempted but failed (a placeholder
    // slice was written) → the final recap points at the re-run command.
    const discoverySkips = new Map<string, string>();
    // Connectors onboard could not complete for the user (currently slack in the
    // multi-workspace shape) → the closing checklist re-surfaces these steps and
    // the recap reports them as manual-pending (Issue #384).
    const manualSteps = new Map<string, readonly string[]>();

    // How a connector is named in the human-readable lines: bare in the ordinary
    // run, `google (account 'work')` in account mode. Taken from the shared
    // helper rather than re-spelled, so doctor, the sync warnings and the wizard
    // spell an account identically.
    const { advisoryLabel } = await import("../../connectors/noop-check.ts");

    // 2-4. Per connector: store token, auth test, append config slice.
    for (const connector of connectors) {
      const report: ConnectorReport = {
        connector,
        ...(this.account !== undefined ? { account: this.account } : {}),
        authFlow: onboardBridgeNames().includes(connector) ? "connector-specific" : "generic",
        authStored: false,
        authTest: "skipped",
        configAppended: false,
        configSource: "skipped",
      };

      // A connector with its own auth flow (the manifest declares
      // `connectorSpecificOnboard`; slack, ADR-0011/0042) is driven by its
      // registered bridge (#458), which owns the token store + auth test +
      // config append end to end.
      const bridge = await loadOnboardBridge(connector);
      if (bridge) {
        const abort = await bridge.run({
          stdin: this.context.stdin,
          stdout,
          stderr,
          interactive,
          json: this.json,
          skipAuth: this.skipAuth,
          keychain: (this.context as { keychain?: KeychainBackend }).keychain,
          report,
          discoverySkips,
          manualSteps,
        });
        reports.push(report);
        if (abort !== undefined) return abort;
        continue;
      }

      const who = advisoryLabel(connector, this.account ?? null);

      if (!this.skipAuth) {
        const stored = await this.storeTokenFor(connector, interactive, this.account);
        if (stored === "no-spec") {
          // No generic `auth set` verb and no dedicated bridge — a connector
          // with no token at all (web / local). Bridge connectors (slack) are
          // dispatched above and never reach this branch (#458).
          if (!this.json) {
            stdout.write(
              `${connector}: no generic auth verb — set credentials per ${docsUrl("guide/connectors.md")}.\n`,
            );
          }
        } else if (stored === "no-token") {
          // Empty input with nothing stored: skip this connector's auth instead
          // of aborting the whole run (Issue #559) — aborting here left every
          // later connector unprocessed and printed no recap. The config slice
          // still lands below (same shape as --skip-auth), so the re-run /
          // `auth set` advice stays actionable.
          const authAccount = this.account === undefined ? "" : ` --account ${this.account}`;
          stderr.write(
            `warning: no token provided for ${who} and none is stored — auth skipped for this ` +
              `connector; set it later with \`suasor ${connector} auth set${authAccount}\` or an env ` +
              "override, then re-run `auth test`\n",
          );
        } else if (stored === "store-failed") {
          // storeTokenFor already printed the failure + env-override recovery.
          return 1;
        } else {
          // `stored` wrote the pasted token; `kept` means a credential already
          // resolved and the user pressed Enter to keep it (Issue #559). Both
          // leave a usable credential in place, so both probe it below.
          report.authStored = true;
          if (!this.json) {
            stdout.write(
              stored === "kept"
                ? `${who}: keeping the already-configured token.\n`
                : `${who}: token stored in the OS keychain.\n`,
            );
          }
          const test = await this.authTest(connector, this.account);
          report.authTest = test.ok ? "ok" : "failed";
          report.authTestDetail = test.detail;
          if (!this.json) {
            stdout.write(
              test.ok
                ? `${who}: auth test ok — ${test.detail}\n`
                : `${who}: auth test FAILED — ${test.detail} (token saved; fix and re-run 'auth test')\n`,
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
      const accountAppend =
        this.account === undefined
          ? null
          : await this.appendAccountSlice(
              connector,
              this.account,
              accountPlans.get(connector) as AccountPlan,
            );
      const append: ConfigAppendOutcome =
        accountAppend ?? (await this.appendConfigSlice(connector));
      report.configAppended = append.appended;
      report.configSource = append.appended ? append.source : "skipped";
      if (append.source === "discovery") report.discovered = append.discovered;
      const section =
        this.account === undefined
          ? `[connectors.${connector}]`
          : `[connectors.${connector}.accounts.${this.account}]`;
      if (accountAppend !== null) {
        report.defaultAccount = accountAppend.defaultAccount;
        if (!this.json && accountAppend.baseAppended) {
          stdout.write(
            `${connector}: appended [connectors.${connector}] (enabled = true) to config.toml.\n`,
          );
        }
        // The account that was already syncing. `preserved` is an action the
        // wizard took and belongs in the transcript; `unknown` is an advisory
        // the operator may have to act on, so it goes to stderr regardless of
        // --json (same treatment as the discovery-fallback reason below).
        if (accountAppend.defaultAccount === "preserved" && !this.json) {
          stdout.write(
            `${connector}: appended [connectors.${connector}.accounts.default] so the account ` +
              "that was already syncing keeps its credential, its external ids and its ingest.\n",
          );
        } else if (accountAppend.defaultAccount === "unknown") {
          stderr.write(
            `${connector}: the flat [connectors.${connector}] keys are now inherited defaults for ` +
              `'${this.account}', not an ingested account of their own. No credential is stored for ` +
              "the unnamed default account, so whether one was ever ingesting cannot be told from " +
              `here — if it should sync too, add [connectors.${connector}.accounts.default] (it may ` +
              "be empty).\n",
          );
        }
      }
      if (!this.json) {
        if (!append.appended) {
          stdout.write(`${who}: ${section} already in config.toml (left untouched).\n`);
        } else if (append.source === "discovery") {
          stdout.write(
            `${who}: discovered ${append.discovered} item(s); appended ${section} to config.toml.\n`,
          );
        } else if (this.account !== undefined) {
          stdout.write(`${who}: appended ${section} to config.toml.\n`);
        } else {
          stdout.write(`${who}: appended ${section} (enabled = true) to config.toml.\n`);
        }
      }
      // The discovery-fallback reason goes to stderr regardless of --json (it is
      // not part of the machine-readable stdout summary, but the operator should
      // know discovery did not run so the placeholder needs hand-editing).
      if (append.discoveryError) {
        // `--account` is carried into the re-run: a discovery verb refuses an
        // unnamed target once several accounts are configured (ADR-0050), so the
        // bare command would not be runnable advice.
        const verbAccount = this.account === undefined ? "" : ` --account ${this.account}`;
        stderr.write(
          `${who}: discovery skipped (${append.discoveryError}); wrote the placeholder slice — edit it by hand or re-run \`suasor ${connector} ${append.discoveryVerb}${verbAccount}\`.\n`,
        );
        if (append.discoveryVerb) discoverySkips.set(connector, append.discoveryVerb);
      }

      reports.push(report);
    }

    // 5. First sync. Its pre-sync advisories go to stderr as they do for `suasor
    // sync`; the labels they were raised for are carried to the recap (step 9) so
    // the closing verdict cannot read "Setup complete." over an open one (#544).
    let synced = false;
    let syncExitCode: number | null = null;
    let configWarnings: readonly string[] = [];
    let embeddings: EmbeddingRecap | null = null;
    if (!this.skipSync) {
      const result = await this.firstSync(connectors);
      synced = true;
      syncExitCode = result.code;
      configWarnings = result.configWarnings;
      embeddings = result.embeddings;
      if (!this.json) stdout.write(result.summary);
    }

    // 6. Scheduler template. The printed cron / launchd / systemd entries assume
    // a global `suasor` on PATH; from source / bunx no such binary exists, so we
    // detect the likely invocation channel and append a substitution note (and,
    // when --write-cron resolves to a non-PATH channel, a louder warning).
    // Inside the Docker image (Issue #558) the templates are for the HOST, so the
    // command becomes the host-side `docker run` form and the kind is forced to
    // cron (the container's `linux` platform says nothing about the host OS;
    // cron is the portable POSIX fallback).
    const channel = detectInvocationChannel(process.argv, process.execPath, process.env);
    const command = channel === "docker" ? DOCKER_RUN_COMMAND : invocationCommand();
    const scheduler = renderSchedulerSnippet(
      process.platform,
      command,
      channel === "docker" ? "cron" : undefined,
    );
    if (this.writeCron) {
      if (channel === "docker") {
        stderr.write(
          "warning: --write-cron writes to the CONTAINER's crontab, which dies with the " +
            "container. Copy the cron line from the template below into the host's crontab " +
            "instead.\n",
        );
      } else if (channel !== "global") {
        stderr.write(
          `warning: --write-cron wrote a literal \`${command}\` line, but you appear to be running ` +
            `via ${channel} — \`${command}\` is likely not on PATH for cron. ` +
            "Edit the crontab entry to use your real invocation.\n",
        );
      }
      const wrote = await this.appendCron(command);
      if (!this.json) {
        stdout.write(wrote ? "Appended the cron line to your crontab.\n" : "");
      }
    }
    // --write-launchd / --write-systemd (Issue #442): the same opt-in as
    // --write-cron for the two file-based schedulers. Both stay explicit — the
    // wizard never installs a background job the operator did not ask for
    // (ADR-0027: Suasor runs no daemon, and it does not quietly arrange one).
    if (this.writeLaunchd || this.writeSystemd) {
      if (channel === "docker") {
        stderr.write(
          "warning: --write-launchd / --write-systemd writes inside the CONTAINER's " +
            "filesystem, which the host's scheduler never reads. Install the unit on " +
            "the host instead (see the template below).\n",
        );
      }
      const kind = this.writeLaunchd ? "launchd" : "systemd";
      const written = await this.writeSchedulerUnit(kind, command);
      if (!this.json && written !== null) {
        stdout.write(`Wrote ${written.paths.join(", ")}.\n`);
        stdout.write(`Activate it with:\n  ${written.activate}\n`);
      }
    }
    if (!this.json) {
      stdout.write(`\nPeriodic sync — ${scheduler.label} (Suasor runs no daemon, ADR-0027):\n`);
      stdout.write(`${scheduler.snippet}\n`);
      stdout.write(`${invocationNote(channel)}\n`);
    }

    // 6b. Digest push lane (ADR-0040). If the operator already configured
    // [digest.jobs] (standing consent), surface ready-to-paste scheduler lines
    // right next to the sync template; otherwise a one-line pointer to the
    // scheduling guide. Config-load failures degrade to the pointer — the
    // wizard must never fail on a half-written config (#403 precedent).
    const digestJobs = await this.digestJobRefs();
    if (!this.json) {
      const digestLines = renderDigestSchedulerLines(scheduler.kind, command, digestJobs);
      if (digestLines !== null) {
        stdout.write(
          `\nDigest push — ${digestJobs.length} standing-consent job(s) in [digest.jobs] (ADR-0040):\n`,
        );
        stdout.write(`${digestLines}\n`);
      } else {
        stdout.write(
          "\nDigest push: no [digest.jobs] configured — proactive digests stay off " +
            `(standing consent, ADR-0040). Enable via ${docsUrl("guide/scheduling.md")}.\n`,
        );
      }
    }

    // 7. MCP registration snippet. Unlike the scheduler block (which ships a
    // literal `suasor` + a substitution note), a global `suasor` is not on PATH
    // from source / bunx, so we substitute the detected channel's real invocation
    // into command+args (Issue #388 item 2). The note below then confirms the
    // block is ready to paste rather than telling the user to replace a `suasor`
    // token the block no longer contains.
    if (!this.json) {
      const mcp = resolveMcpInvocation(channel, process.argv[1] ?? "");
      stdout.write(
        "\nRegister the MCP server with your agent host (claude_desktop_config.json):\n",
      );
      stdout.write(`${renderMcpSnippet(mcp)}\n`);
      stdout.write(`${mcpInvocationNote(channel)}\n`);
    }

    // 8. Re-surface the connector-specific setup onboard could not complete for
    // the user — currently a multi-workspace slack config, whose per-workspace
    // tokens onboard's single stdin cannot drive (Issue #384). A flat slack config
    // is bridged inline (token + auth test + channels), so it is *not* re-surfaced.
    // This runs last so the final thing on screen is the unfinished checklist
    // rather than the sync + scheduler / MCP blocks, which otherwise read as
    // "all done".
    if (!this.json) {
      for (const [connector, steps] of manualSteps) {
        const numbered = steps.map((step, i) => `  ${i + 1}. ${step}`).join("\n");
        stdout.write(
          `\n${connector}: setup is not complete yet — finish these steps:\n${numbered}\n`,
        );
      }
    }

    // 9. Final recap: close the screen with a per-connector success / failure
    // summary so an auth-test / sync failure is not masked by the scheduler / MCP
    // blocks above, which otherwise read as "all done" (Issue #388 item 1).
    // Human-readable output only — --json carries the same outcome in
    // OnboardReport (connectors[].authTest, syncExitCode).
    const recap: RecapConnector[] = reports.map((r) => {
      const verb = discoverySkips.get(r.connector);
      // A connector-specific connector onboard *bridged* (flat slack) reads like a
      // generic one in the recap (auth ok / skipped, config appended). Only a
      // connector left with manual steps (multi-workspace slack) stays
      // `connector-specific`, so the recap surfaces "finish the steps above" and
      // the closing verdict is "needs manual steps" (Issue #384).
      const authFlow = manualSteps.has(r.connector) ? "connector-specific" : "generic";
      return {
        connector: r.connector,
        ...(r.account !== undefined ? { account: r.account } : {}),
        authFlow,
        authTest: r.authTest,
        configSource: r.configSource,
        ...(r.discovered !== undefined ? { discovered: r.discovered } : {}),
        ...(verb !== undefined ? { discoverySkippedVerb: verb } : {}),
      };
    });
    const recapInput = {
      connectors: recap,
      synced,
      syncExitCode,
      configWarnings,
      ...(embeddings !== null ? { embeddings } : {}),
    };
    if (!this.json) {
      stdout.write(`\n${renderRecap(recapInput)}\n`);
    }

    if (this.json) {
      const report: OnboardReport = {
        connectors: reports,
        synced,
        syncExitCode,
        scheduler: scheduler.kind,
        digestJobs: digestJobs.map((j) => j.name),
        embeddings,
      };
      stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    }

    // Surface an auth-test failure or a sync failure via exit code (cron/CI
    // parity) without aborting the wizard's printed guidance (Issue #388 item 1).
    return recapHasFailure(recapInput) ? 1 : 0;
  }

  /**
   * Read the configured `[digest.jobs]` for the scheduler step (ADR-0040).
   * Best-effort: any config-load failure degrades to "none configured" — the
   * wizard's guidance must never fail on a half-written config (#403).
   */
  private async digestJobRefs(): Promise<DigestJobRef[]> {
    try {
      const { loadConfig } = await import("../../config/index.ts");
      const config = await loadConfig();
      return config.digest.jobs.map((j) => ({ name: j.name, schedule: j.schedule }));
    } catch {
      return [];
    }
  }

  /** Resolve and validate an explicit `--connector` list. */
  private resolveConnectors(): { connectors: string[] } | { error: string } {
    const known = new Set(connectorNames());
    // Only called when --connector was provided (interactive prompt handles the
    // unset case in promptConnectors).
    const requested = (this.connector ?? "")
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

  /**
   * Interactive connector selection (ADR-0029 §2). On a TTY stdin with no
   * `--connector`, render a numbered menu, read one line, and resolve it with
   * the pure {@link resolveSelection} helper. On a non-TTY stdin (a pipe / CI)
   * prompting is unsafe, so we keep the explicit-error behavior (no silent wrong
   * answer, ADR-0007 / ADR-0029 §4).
   */
  private async promptConnectors(): Promise<{ connectors: string[] } | { error: string }> {
    if (!isInteractive(this.context.stdin)) {
      return {
        error:
          "--connector is required when stdin is not a TTY " +
          "(non-interactive setup cannot prompt for the connector selection)",
      };
    }
    // In the standalone binary the menu offers only the bundled connectors
    // (Issue #557): listing slack / google / box / ms-graph there invites the
    // user to paste a token into a flow that cannot store or verify it.
    const all = connectorNames();
    const binary = currentBuildIsBinary();
    const candidates = binary ? all.filter((name) => connectorBundledInBinary(name)) : all;
    if (binary && candidates.length < all.length) {
      this.context.stdout.write(
        `note: this standalone binary bundles only: ${candidates.join(", ")} — ` +
          `set up the rest via the npm package or Docker (see ${BINARY_SCOPE_DOC}).\n`,
      );
    }
    this.context.stdout.write(renderConnectorMenu(candidates));
    const raw = (await readLine(this.context.stdin)).trim();
    return resolveSelection(raw, candidates);
  }

  /**
   * Keychain backend override, injected via the CLI context for tests so token
   * storage never touches the real OS keyring. Undefined in production, where
   * {@link import("../../connectors/secrets.ts").storeSecret} lazy-loads the
   * native `@napi-rs/keyring` backend.
   */
  private keychainOptions(): { keychain?: KeychainBackend } {
    const keychain = (this.context as { keychain?: KeychainBackend }).keychain;
    return keychain ? { keychain } : {};
  }

  /**
   * Resolve everything `--account` mode needs before the first write (see
   * {@link AccountPlan}), or return a ready-to-print refusal.
   *
   * Every refusal here is a state that would otherwise surface much later and
   * much worse:
   * - a connector that declares no per-account configuration would take the
   *   token under a name nothing resolves (the connector set is read from the
   *   manifests, never listed here — the next connector to adopt multi-account
   *   joins this verb by flipping its own flag);
   * - a name outside the account charset, or one whose env-override segment
   *   collides with a configured account, produces a `config.toml` that no
   *   longer *loads* — written by the wizard, on the operator's next run;
   * - a config that cannot be loaded leaves "is an account about to be demoted"
   *   unanswerable, and that question has no safe default.
   */
  private async prepareAccountMode(
    connectors: string[],
    account: string,
  ): Promise<{ plans: Map<string, AccountPlan> } | { error: string }> {
    const [{ connectorManifest, multiAccountConnectorNames }, multi] = await Promise.all([
      import("../../connectors/manifest.ts"),
      import("../../connectors/multi-account.ts"),
    ]);
    if (!multi.ACCOUNT_NAME_PATTERN.test(account)) {
      return {
        error:
          `invalid account name '${account}' — use letters, digits, '_' or '-' ` +
          "(the name becomes a keychain account, an env var and an external-id segment)",
      };
    }
    const unsupported = connectors.filter((n) => connectorManifest(n)?.multiAccount !== true);
    if (unsupported.length > 0) {
      // The same sentence the `auth` / discovery verbs refuse with (#544): one
      // mistake, one answer, whichever verb the operator reached for.
      return { error: noPerAccountConfigMessage(unsupported, multiAccountConnectorNames()) };
    }
    let connectorsConfig: Record<string, Record<string, unknown> | undefined>;
    try {
      const { loadConfig } = await import("../../config/index.ts");
      connectorsConfig = (await loadConfig()).connectors as Record<
        string,
        Record<string, unknown> | undefined
      >;
    } catch (cause) {
      return {
        error: `${cause instanceof Error ? cause.message : String(cause)} — fix config.toml before adding an account`,
      };
    }
    const plans = new Map<string, AccountPlan>();
    for (const connector of connectors) {
      const slice = connectorsConfig[connector];
      const segment = multi.accountEnvSegment(account);
      const declared = multi.accountSlices(slice).filter((a) => a.declared);
      const clash = declared.find(
        (a) => a.name !== account && multi.accountEnvSegment(a.name) === segment,
      );
      if (clash) {
        return {
          error:
            `account '${account}' and the configured '${clash.name}' both map to the env override ` +
            `segment '${segment}', so one would answer for the other — pick another name`,
        };
      }
      plans.set(connector, {
        connectorConfigured: slice !== undefined,
        accountsDeclared: multi.hasDeclaredAccounts(slice),
        accountDeclared: declared.some((a) => a.name === account),
      });
    }
    return { plans };
  }

  /**
   * The account slice a not-yet-written `[connectors.<c>.accounts.<a>]` will
   * resolve to: this account's own keys (none yet) over the inherited flat keys.
   *
   * Built by feeding a synthetic empty table through the shared
   * {@link import("../../connectors/multi-account.ts").accountSlices} rather than
   * merging by hand, so the wizard's view of "what will this account see" is the
   * same resolution the connector, doctor and the auth verbs use.
   */
  private async prospectiveAccount(
    slice: Record<string, unknown>,
    account: string,
  ): Promise<AccountSlice> {
    const { accountSlices, ACCOUNTS_KEY } = await import("../../connectors/multi-account.ts");
    const declared = slice[ACCOUNTS_KEY];
    const existing =
      typeof declared === "object" && declared !== null && !Array.isArray(declared)
        ? (declared as Record<string, unknown>)
        : {};
    const merged = {
      ...slice,
      [ACCOUNTS_KEY]: { ...existing, [account]: existing[account] ?? {} },
    };
    return accountSlices(merged).find((a) => a.name === account) as AccountSlice;
  }

  /**
   * Read a token from stdin and store it in the keychain. Returns a status tag.
   *
   * A credential that already resolves (keychain or env override — a re-run of
   * the wizard, Issue #559) turns the prompt into "press Enter to keep it": the
   * recap explicitly tells users to fix things and re-run, and demanding a
   * re-paste of a token that is already stored made every re-run abort at the
   * first Enter.
   */
  private async storeTokenFor(
    connector: string,
    interactive: boolean,
    account?: string,
  ): Promise<"stored" | "kept" | "no-token" | "no-spec" | "store-failed"> {
    const { AUTH_SPECS } = await import("../../connectors/auth-specs.ts");
    const spec = AUTH_SPECS[connector];
    if (!spec) return "no-spec";

    // In account mode the credential is stored under the account's own secret
    // name — the same `auth set --account` path (ADR-0050 決定 3), not a second
    // way to persist a token.
    const { accountSecretName, DEFAULT_ACCOUNT_NAME } = await import(
      "../../connectors/multi-account.ts"
    );
    const secretName =
      account === undefined
        ? spec.secretName
        : accountSecretName(
            { name: account, isDefault: account === DEFAULT_ACCOUNT_NAME },
            spec.secretName,
          );

    // Presence only, never the value (NFR-PRV-4): decides whether an empty
    // Enter means "keep the stored token" (re-run, Issue #559) or "no token".
    const { resolveSecret, storeSecret, storeSecretErrorMessage } = await import(
      "../../connectors/secrets.ts"
    );
    const alreadyStored =
      (await resolveSecret(connector, secretName, this.keychainOptions())) !== null;

    if (interactive) {
      const forAccount = account === undefined ? "" : ` for account '${account}'`;
      this.context.stdout.write(
        alreadyStored
          ? `A ${connector} ${spec.secretLabel}${forAccount} is already configured — press Enter to keep it, or paste a new one (input is read from stdin):\n`
          : `Paste the ${connector} ${spec.secretLabel}${forAccount} and press Enter (input is read from stdin):\n`,
      );
    }
    // Line-based, echo-suppressed read (Issue #383): on a TTY this resolves on
    // Enter instead of hanging for EOF, and never echoes the token in cleartext.
    // Over a pipe it consumes a single line, so successive connectors each read
    // their own token line rather than the first draining stdin to EOF.
    const token = (
      await readSecretLine(this.context.stdin, this.context.stderr, { mask: true })
    ).trim();
    if (!token) return alreadyStored ? "kept" : "no-token";

    try {
      await storeSecret(connector, secretName, token, this.keychainOptions());
    } catch (cause) {
      // A headless host (Docker, a server) has no Secret Service: surface the
      // env-override escape hatch instead of the raw native error (Issue #557).
      this.context.stderr.write(storeSecretErrorMessage(connector, secretName, cause));
      this.context.stderr.write("hint: then re-run this wizard with --skip-auth\n");
      return "store-failed";
    }
    return "stored";
  }

  /** Run the connector's `auth test` probe and normalize the outcome. */
  private async authTest(
    connector: string,
    account?: string,
  ): Promise<{ ok: boolean; detail: string }> {
    const { AUTH_SPECS } = await import("../../connectors/auth-specs.ts");
    const spec = AUTH_SPECS[connector];
    if (!spec) return { ok: false, detail: "no auth spec" };

    const [{ loadConfig }, { makeSecretResolver }] = await Promise.all([
      import("../../config/index.ts"),
      import("../../connectors/secrets.ts"),
    ]);
    const config = await loadConfig();
    const slice = (config.connectors[connector] ?? {}) as Record<string, unknown>;
    const resolver = makeSecretResolver(connector);
    // Account mode probes the credential that was just stored, against the
    // settings that account will actually see (its own keys over the inherited
    // flat ones) — testing the flat slice with the default account's token would
    // report `ok` for a credential the new account never uses.
    const target = account === undefined ? null : await this.prospectiveAccount(slice, account);
    let secret = resolver;
    if (target !== null) {
      const { accountSecretName } = await import("../../connectors/multi-account.ts");
      secret = (name: string) => resolver(accountSecretName(target, name));
    }
    try {
      const report = await spec.test({ secret, config: target?.slice ?? slice });
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
   * Append a `[connectors.<name>.accounts.<account>]` table (ADR-0050 / Issue
   * #538) — the account-mode counterpart of {@link appendConfigSlice}, and the
   * same non-destructive contract (an account table the operator already wrote
   * is never rewritten).
   *
   * Three writes, in the order that keeps the install correct at every step:
   *
   * 1. the connector's own `[connectors.<name>]` slice when the config has none
   *    — `enabled` is read at the connector level, so an account table alone
   *    enables nothing. No discovery here: the ids belong in the account's table,
   *    not in the flat defaults every future account would inherit;
   * 2. `[connectors.<name>.accounts.default]`, when this run is what demotes an
   *    already-syncing flat config and a stored credential is evidence that
   *    account was real (see {@link DefaultAccountOutcome});
   * 3. the new account's table — the discovered ids when its own credential can
   *    enumerate them, else a template that says the inherited scope ids belong
   *    to a different account.
   */
  private async appendAccountSlice(
    connector: string,
    account: string,
    plan: AccountPlan,
  ): Promise<AccountAppendOutcome> {
    const [{ resolveConfigDir }, configAppend, { DEFAULT_ACCOUNT_NAME }, { join }] =
      await Promise.all([
        import("../../config/index.ts"),
        import("../onboard/config-append.ts"),
        import("../../connectors/multi-account.ts"),
        import("node:path"),
      ]);
    const configPath = join(resolveConfigDir(process.env), "config.toml");
    const file = Bun.file(configPath);
    let toml = (await file.exists()) ? await file.text() : "";
    let dirty = false;

    let baseAppended = false;
    if (!plan.connectorConfigured) {
      const base = configAppend.appendConnectorSlice(toml, connector);
      if (base.appended) {
        toml = base.toml;
        baseAppended = true;
        dirty = true;
      }
    }

    let defaultAccount: DefaultAccountOutcome = "not-applicable";
    if (plan.connectorConfigured && !plan.accountsDeclared && account !== DEFAULT_ACCOUNT_NAME) {
      defaultAccount = (await this.defaultAccountCredentialStored(connector))
        ? "preserved"
        : "unknown";
      if (defaultAccount === "preserved") {
        const kept = configAppend.appendConnectorAccountSlice(
          toml,
          connector,
          DEFAULT_ACCOUNT_NAME,
          configAppend.connectorDefaultAccountTemplate(connector),
        );
        if (kept.appended) {
          toml = kept.toml;
          dirty = true;
        }
      }
    }

    // Already declared → leave it alone. The parsed-config answer
    // (`plan.accountDeclared`) is checked as well as the header scan because the
    // two disagree on `[connectors.box.accounts."work"]`, and appending there
    // would produce two tables for one account.
    if (plan.accountDeclared || configAppend.hasConnectorAccountSlice(toml, connector, account)) {
      if (dirty) await Bun.write(configPath, toml);
      return { appended: false, source: "skipped", defaultAccount, baseAppended };
    }

    const discovery = await this.discoverConfigBlock(connector, account);
    if (discovery && "configBlock" in discovery) {
      const result = configAppend.appendConnectorAccountSlice(
        toml,
        connector,
        account,
        configAppend.accountBodyFromBlock(connector, discovery.configBlock),
      );
      await Bun.write(configPath, result.toml);
      return {
        appended: result.appended,
        source: "discovery",
        discovered: discovery.count,
        defaultAccount,
        baseAppended,
      };
    }

    const result = configAppend.appendConnectorAccountSlice(
      toml,
      connector,
      account,
      configAppend.connectorAccountTemplate(connector),
    );
    await Bun.write(configPath, result.toml);
    return {
      appended: result.appended,
      source: "template",
      ...(discovery?.error
        ? { discoveryError: discovery.error, discoveryVerb: discovery.verb }
        : {}),
      defaultAccount,
      baseAppended,
    };
  }

  /**
   * Whether a credential for the **unnamed default** account still resolves
   * (keychain or env override) — the one fact that separates doctor's two
   * confidence levels for a demoted flat config (ADR-0050 決定 5).
   *
   * Presence only, never a value (NFR-PRV-4). Any of the connector's declared
   * secrets counts: a connector needing two of them is still evidence of an
   * account when one is stored.
   */
  private async defaultAccountCredentialStored(connector: string): Promise<boolean> {
    const [{ connectorManifest }, { resolveSecret }] = await Promise.all([
      import("../../connectors/manifest.ts"),
      import("../../connectors/secrets.ts"),
    ]);
    for (const secret of connectorManifest(connector)?.secretNames ?? []) {
      if ((await resolveSecret(connector, secret, this.keychainOptions())) !== null) return true;
    }
    return false;
  }

  /**
   * Run the connector's discovery probe (ADR-0030) and return the rendered
   * `[connectors.X]` block + item count. Returns `null` when the connector has
   * no discovery verb, or `{ error, verb }` when the probe failed (so the caller
   * falls back to the placeholder template and surfaces the reason). Best-effort
   * and read-only; the credential is never echoed.
   *
   * With `account`, the probe runs as **that** account — its own credential, its
   * own inherited settings — because the ids are what makes the account mode
   * worth having: a Box folder id or a Google calendar id enumerated by the first
   * account addresses nothing in the second (ADR-0050 決定 1).
   */
  private async discoverConfigBlock(
    connector: string,
    account?: string,
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
    const resolver = makeSecretResolver(connector);
    const target = account === undefined ? null : await this.prospectiveAccount(slice, account);
    let secret = resolver;
    if (target !== null) {
      const { accountSecretName } = await import("../../connectors/multi-account.ts");
      secret = (name: string) => resolver(accountSecretName(target, name));
    }
    try {
      const result = await spec.discover({ secret, config: target?.slice ?? slice });
      return { configBlock: result.configBlock, count: result.items.length };
    } catch (cause) {
      return { error: cause instanceof Error ? cause.message : String(cause), verb: spec.verb };
    }
  }

  /**
   * Run the first `suasor sync` over the selected connectors via the shared
   * service.
   *
   * The wizard's sync **is** a `suasor sync`, so it ingests like one: the
   * embedder, the extractor and the two extraction caps come from the same config
   * and are wired to the same sinks as `src/cli/commands/sync-all.ts` (Issue
   * #547). Passing them is not a nicety — `syncConnector` skips a
   * fingerprint-unchanged source *before* extraction and *before* embedding, so a
   * source the first pass ingests without a vector is one no later `suasor sync`
   * ever embeds. The first pass is also the one that ingests the whole backlog,
   * so leaving it out left semantic search permanently blind to exactly the
   * corpus onboarding brought in, with `suasor embeddings drain` as an
   * undiscoverable manual repair.
   *
   * `configWarnings` carries the labels (`google (account 'work')`) of the slices
   * the pre-sync advisories fired for, for the closing recap — **not** their text:
   * the text is printed by the sync itself, through `onWarn`, exactly where and
   * how `suasor sync` prints it. The labels come from the run's own
   * `preSyncAdvisories`, so the recap can never disagree with what was printed.
   *
   * `embeddings` reports what the run left without a vector (see
   * {@link EmbeddingRecap}), read from the run's own counters rather than
   * re-derived: with no backend configured that is every ingested source, and
   * with a backend whose sidecar failed it is the difference the best-effort
   * embed left behind. Either way the gap outlives the run, so the recap states
   * it and names the one command that closes it.
   */
  private async firstSync(connectors: string[]): Promise<{
    code: number;
    summary: string;
    configWarnings: string[];
    embeddings: EmbeddingRecap | null;
  }> {
    const [
      { loadConfig },
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

    const config = await loadConfig();
    const dbPath = config.storage.dbPath;
    if (dbPath === null) {
      return {
        code: 1,
        summary: "sync: storage.dbPath is not configured.\n",
        configWarnings: [],
        embeddings: null,
      };
    }
    // Only the connectors we just enabled (intersect with the enabled set so an
    // append-skipped, enabled=false slice is honored).
    const enabled = new Set(selectEnabledConnectors(connectorNames(), config.connectors));
    const names = connectors.filter((n) => enabled.has(n));
    if (names.length === 0) {
      return {
        code: 0,
        summary: "sync: no enabled connectors to ingest (skipped first sync).\n",
        configWarnings: [],
        embeddings: null,
      };
    }

    // Same construction as `suasor sync`: `null` when the backend is disabled
    // (the FTS-first default, ADR-0005) — the wizard then costs exactly what it
    // did before, because nothing is sent anywhere. `onTruncate` counts bodies
    // capped to `[embedding].maxInputChars` so the deterministic truncation is
    // reported here too, rather than only under `suasor sync`.
    let truncatedCount = 0;
    const embedder = await createEmbedderResolved(config.embedding, {
      onTruncate: () => {
        truncatedCount += 1;
      },
    });
    const extractor = createExtractor(config.extraction);
    // TTY-gated (a no-op on a pipe / CI, so `--json` and captured output are
    // unaffected): with a sidecar wired the first pass is the long one, and a
    // wizard that goes silent for minutes reads as hung.
    const progress = createProgress(this.context.stderr, "sync");

    const store = Store.open({ path: dbPath, embeddingDim: config.embedding.dim });
    try {
      const result = await runBulkSync(store, {
        names,
        connectors: config.connectors,
        loadConnector,
        continueOnError: true,
        // The wizard's sync is a `suasor sync` — so it warns like one (Issue
        // #544). Without `onWarn` wired, `runBulkSync` drops the pre-sync
        // advisories it emits for every other caller (an empty ingest scope,
        // #187; a required setting left unset, ADR-0049 / ADR-0051), and the
        // freshly onboarded connector that will never ingest stayed silent here
        // while `suasor sync` said so loudly. Same stream, same `warning: `
        // prefix, same position (before any connector runs) as
        // `src/cli/commands/sync-all.ts`.
        syncOptions: {
          embedder,
          extractor,
          extractionMaxBytes: config.extraction.maxBytes,
          extractionMaxTextChars: config.extraction.maxTextChars,
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
      });
      progress.finish();

      if (truncatedCount > 0) {
        this.context.stderr.write(
          `warning: ${truncatedCount} long document(s) truncated to ` +
            `${config.embedding.maxInputChars} chars before embedding ` +
            `(recall covers the head only; see ${docsUrl("guide/embedding.md")})\n`,
        );
      }

      // The counts `suasor sync` prints, for the same reason it prints them: the
      // embedded / extracted columns are how an operator sees that the optional
      // layers ran at all. The `embedded` / `extracted` clauses are omitted when
      // the corresponding backend is disabled — a `0 embedded` on a disabled
      // backend would read as a failure of something that was never asked to run.
      const lines = result.results.map((entry) => {
        if (!(entry.ok && entry.outcome)) return `${entry.connector}: failed (${entry.error}).`;
        const o = entry.outcome;
        return (
          `${entry.connector}: ${o.observed} observed, ${o.updated} updated, ` +
          `${o.unchanged} unchanged${embedder ? `, ${o.embedded} embedded` : ""}` +
          `${extractor ? `, ${o.extracted} extracted` : ""}.`
        );
      });
      const summary = `${lines.join("\n")}\nsync: ${result.succeeded} succeeded, ${result.failed} failed.\n`;
      // The labels the recap points at are read back from the run itself, not
      // re-derived: one slice can raise both advisories, and only the run knows
      // which ones it actually emitted.
      const { advisoryLabel } = await import("../../connectors/noop-check.ts");
      const configWarnings: string[] = [];
      for (const advisory of result.preSyncAdvisories) {
        const label = advisoryLabel(advisory.connector, advisory.account);
        if (!configWarnings.includes(label)) configWarnings.push(label);
      }
      // What this run left without a vector. `observed + updated` is exactly the
      // set `syncConnector` offers the embedder (unchanged sources are skipped
      // before it), so `embedded < ingested` is the count that stays pending —
      // whether because no backend was configured or because the best-effort
      // embed could not reach the sidecar. A connector that threw contributes
      // nothing: it reported no counters, and a number nobody measured is not one
      // to state.
      const ingested = result.results.reduce(
        (n, entry) => n + (entry.outcome ? entry.outcome.observed + entry.outcome.updated : 0),
        0,
      );
      const embedded = result.results.reduce((n, entry) => n + (entry.outcome?.embedded ?? 0), 0);
      const embeddings: EmbeddingRecap | null =
        ingested > 0 && embedded < ingested
          ? { ingested, embedded, backendDisabled: embedder === null }
          : null;
      return { code: result.failed > 0 ? 1 : 0, summary, configWarnings, embeddings };
    } finally {
      store.close();
    }
  }

  /**
   * Write the launchd plist / systemd units to the user's home (Issue #442).
   *
   * Returns the written paths plus the activation command, or `null` when the
   * write failed (reported on stderr). Existing files are **not** overwritten:
   * a hand-tuned unit is the operator's, and silently replacing it would be the
   * kind of surprise that makes a wizard untrustworthy.
   */
  private async writeSchedulerUnit(
    kind: "launchd" | "systemd",
    command: string,
  ): Promise<{ paths: string[]; activate: string } | null> {
    const [{ renderSchedulerSnippet, schedulerUnitTarget, splitSystemdUnits }, { homedir }, fs] =
      await Promise.all([
        import("../onboard/scheduler.ts"),
        import("node:os"),
        import("node:fs/promises"),
      ]);
    const target = schedulerUnitTarget(kind);
    if (target === null) return null;
    const snippet = renderSchedulerSnippet(process.platform, command, kind).snippet;
    const files =
      kind === "systemd"
        ? splitSystemdUnits(snippet)
        : [{ relativePath: target.relativePath, body: `${snippet}\n` }];
    const home = homedir();
    const { dirname, join } = await import("node:path");
    const written: string[] = [];
    for (const file of files) {
      const path = join(home, file.relativePath);
      try {
        await fs.mkdir(dirname(path), { recursive: true });
        // `wx` fails when the file exists — never clobber an existing unit.
        await fs.writeFile(path, file.body, { flag: "wx" });
        written.push(path);
      } catch (cause) {
        const exists = (cause as { code?: string } | undefined)?.code === "EEXIST";
        this.context.stderr.write(
          exists
            ? `warning: ${path} already exists — left untouched (edit it by hand if the command changed)\n`
            : `warning: could not write ${path}: ${cause instanceof Error ? cause.message : String(cause)}\n`,
        );
      }
    }
    if (written.length === 0) return null;
    return { paths: written, activate: target.activate };
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

/**
 * Read a single line from stdin (up to and excluding the first newline). Used by
 * the interactive connector prompt so the rest of stdin stays available for the
 * subsequent per-connector token reads. On EOF the accumulated buffer is
 * returned (a TTY user pressing Enter terminates the line).
 */
async function readLine(stdin: AsyncIterable<Buffer | string>): Promise<string> {
  let buffer = "";
  for await (const chunk of stdin) {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : (chunk as string);
    const newline = buffer.indexOf("\n");
    if (newline >= 0) return buffer.slice(0, newline);
  }
  return buffer;
}

/** Exported for tests: the connectors that expose the generic auth verbs. */
export const ONBOARD_AUTH_CONNECTORS = authConnectorNames();
