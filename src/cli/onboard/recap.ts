/**
 * Final per-connector setup recap for `suasor onboard` step 9 (Issue #388 item 1).
 *
 * The wizard runs to completion even when a step fails — an `auth test` probe
 * rejects, or the first `sync` fails — so without a closing summary the last
 * thing on screen is the scheduler / MCP block, which reads as "all done" even
 * after a failure. This pure builder renders a per-connector `auth ok` /
 * `auth test FAILED` / config-status recap plus the recovery command for each
 * failure, so the final screen states the real outcome. The caller pairs it with
 * a non-zero exit code (any `auth test` failed, or the first sync exited > 0) for
 * cron / CI parity — the recap itself never touches process state.
 */

/** One connector's outcome as the recap needs it (a projection of `ConnectorReport`). */
export interface RecapConnector {
  readonly connector: string;
  /**
   * The named account this run configured (`--account`, ADR-0050), or absent for
   * the ordinary flat-slice run. Present, it renames every clause: the recovery
   * command needs `--account <name>` (without it `auth test` on a multi-account
   * config either refuses as ambiguous or tests the wrong account), and the
   * config clause points at the account's own table.
   */
  readonly account?: string;
  /** `generic` (AUTH_SPECS verbs) vs `connector-specific` (slack's own flow). */
  readonly authFlow: "generic" | "connector-specific";
  /** Outcome of the `auth test` probe (or `skipped` under --skip-auth / no spec). */
  readonly authTest: "ok" | "failed" | "skipped";
  /** How the `[connectors.X]` slice was produced. */
  readonly configSource: "discovery" | "template" | "skipped";
  /** Discovered id count (only meaningful when `configSource === "discovery"`). */
  readonly discovered?: number;
  /**
   * Discovery verb name, set only when a discovery probe was *attempted but
   * failed* and the placeholder template was written instead (so the recap can
   * point at the re-run command). Absent for connectors with no discovery verb.
   */
  readonly discoverySkippedVerb?: string;
}

/** Everything the recap renders from. */
export interface RecapInput {
  readonly connectors: readonly RecapConnector[];
  /** Whether the first sync ran (false under --skip-sync). */
  readonly synced: boolean;
  /** First-sync exit code (`null` when skipped). */
  readonly syncExitCode: number | null;
}

/** Whether the run should exit non-zero: any auth-test failure, or a failed sync. */
export function recapHasFailure(input: RecapInput): boolean {
  const authFailed = input.connectors.some((c) => c.authTest === "failed");
  const syncFailed = input.syncExitCode !== null && input.syncExitCode > 0;
  return authFailed || syncFailed;
}

/**
 * The connector label, matching `advisoryLabel` in
 * `src/connectors/noop-check.ts` (`google (account 'work')`) so doctor, the sync
 * warnings and this recap name an account the same way. Re-spelled rather than
 * imported: that module pulls every connector manifest, and this file is on the
 * CLI's top-level import path (NFR-PRF-1).
 */
function label(c: RecapConnector): string {
  return c.account === undefined ? c.connector : `${c.connector} (account '${c.account}')`;
}

/** The `--account <name>` suffix for a recovery command (empty for a flat run). */
function accountFlag(c: RecapConnector): string {
  return c.account === undefined ? "" : ` --account ${c.account}`;
}

/** The `auth …` clause for one connector. */
function authPhrase(c: RecapConnector): string {
  if (c.authTest === "ok") return "auth ok";
  if (c.authTest === "failed") {
    return `auth test FAILED — token saved; fix it and re-run \`suasor ${c.connector} auth test${accountFlag(c)}\``;
  }
  // skipped: connector-specific flows (slack) still need the manual checklist;
  // a generic connector was simply skipped (--skip-auth / env-override install).
  if (c.authFlow === "connector-specific") {
    return "auth: finish the connector-specific steps above";
  }
  return "auth skipped";
}

/** The `config …` clause for one connector. */
function configPhrase(c: RecapConnector): string {
  if (c.configSource === "discovery") {
    return `config appended (${c.discovered ?? 0} discovered)`;
  }
  if (c.configSource === "skipped") return "config already present (left untouched)";
  // template: a placeholder slice was written and needs hand-editing.
  if (c.discoverySkippedVerb) {
    // The re-run needs `--account` too: on a config with several accounts the
    // discovery verb refuses an unnamed target rather than guessing one, so a
    // bare command here would be a suggestion that cannot work (ADR-0050).
    return `config placeholder written — discovery skipped; edit it or re-run \`suasor ${c.connector} ${c.discoverySkippedVerb}${accountFlag(c)}\``;
  }
  const section =
    c.account === undefined
      ? `[connectors.${c.connector}]`
      : `[connectors.${c.connector}.accounts.${c.account}]`;
  return `config placeholder written — edit ${section} in config.toml`;
}

/**
 * Render the closing recap block. Deterministic and side-effect-free; the caller
 * writes it to stdout (human-readable output only) and uses {@link recapHasFailure}
 * for the exit code.
 */
export function renderRecap(input: RecapInput): string {
  const lines: string[] = ["Setup recap:"];
  for (const c of input.connectors) {
    lines.push(`  ${label(c)}: ${authPhrase(c)}; ${configPhrase(c)}.`);
  }

  const syncFailed = input.syncExitCode !== null && input.syncExitCode > 0;
  if (input.synced) {
    lines.push(
      syncFailed
        ? "  sync: FAILED — re-run `suasor sync` after fixing the credentials above"
        : "  sync: ok",
    );
  }

  const authFailed = input.connectors.some((c) => c.authTest === "failed");
  const manualPending = input.connectors.some(
    (c) => c.authFlow === "connector-specific" && c.authTest !== "ok",
  );
  lines.push("");
  if (authFailed || syncFailed) {
    lines.push("Setup finished with errors — see the FAILED line(s) above.");
  } else if (manualPending) {
    lines.push("Setup needs manual steps — finish the connector-specific checklist above.");
  } else {
    lines.push("Setup complete.");
  }
  return lines.join("\n");
}
