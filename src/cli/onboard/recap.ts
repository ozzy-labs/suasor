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
import { docsUrl } from "../doc-ref.ts";
import { type AuthFailureKind, authFailureAdvice } from "./auth-advice.ts";

/**
 * What the first sync left without a vector (Issue #547).
 *
 * Reported because the gap **outlives the run**: `syncConnector` offers the
 * embedder only the sources it observed or updated, so a source ingested without
 * a vector is never embedded by any later `suasor sync` — and the first sync is
 * the one that ingests the backlog. `suasor embeddings drain` is the command that
 * closes it (it embeds exactly the sources with no vector), and naming it here is
 * the same treatment `suasor projections rebuild` gives the vec0 table it drops.
 */
export interface EmbeddingRecap {
  /** Sources this sync ingested (observed + updated) — the embed candidates. */
  readonly ingested: number;
  /** How many of them got a vector (`0` when no backend is configured). */
  readonly embedded: number;
  /** Whether `[embedding].backend` was disabled (vs configured but failing). */
  readonly backendDisabled: boolean;
}

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
  /**
   * Why the probe failed (only meaningful when `authTest === "failed"`):
   * `network` — the API was unreachable, so the fix is connectivity + a re-run,
   * not a re-pasted token; `credential` — the API rejected the token, so
   * `auth set` is the fix (Issue #567). Absent (older callers) reads as
   * `credential`, matching the pre-classification advice.
   */
  readonly authFailureKind?: AuthFailureKind;
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
  /**
   * Labels (`advisoryLabel` spelling) of the slices the first sync's pre-sync
   * advisories were raised for — an empty ingest scope (Issue #187) or an unset
   * required setting (ADR-0049 / ADR-0051). Absent / empty when the sync was
   * skipped or every slice was complete (Issue #544).
   *
   * The recap carries the **labels only**, never the advisory text: the sync
   * already printed each one on stderr, in full, and restating it here would
   * report the same finding twice. What the recap adds is that the closing
   * verdict stops saying "Setup complete." while a connector that will ingest
   * nothing is sitting in the config the wizard just wrote — the same reason the
   * recap exists at all (Issue #388 item 1).
   *
   * Not part of {@link recapHasFailure}: both advisories are documented as
   * warnings that leave the exit code alone (#187, ADR-0049), and the wizard must
   * not start failing runs that `suasor sync` exits 0 on.
   */
  readonly configWarnings?: readonly string[];
  /**
   * The vectors the first sync did not write (Issue #547). Absent when the sync
   * was skipped, ingested nothing, or embedded everything it ingested.
   *
   * Not part of {@link recapHasFailure}, on the same grounds as
   * {@link configWarnings}: a disabled embedding backend is the documented
   * FTS-first default (ADR-0005) and a sidecar failure is best-effort by design,
   * so `suasor sync` exits 0 on both and the wizard must not invent a failure the
   * sync does not have. Stating the gap is the point; failing on it is not.
   */
  readonly embeddings?: EmbeddingRecap;
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
    // Classified advice (Issue #567): an unreachable API gets "check
    // connectivity", a rejected token gets the `auth set` re-store path.
    const kind = c.authFailureKind ?? "credential";
    return `auth test FAILED — ${authFailureAdvice(kind, c.connector, accountFlag(c))}`;
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
 * The `embeddings …` clause: what has no vector, and the one command that fixes
 * it. The two cases are rendered as different sentences because they are
 * different claims — "you never asked for vectors" is a configuration state the
 * operator may well intend, while "the sidecar did not answer" is a failure that
 * already printed on stderr. Folding them into one line would give both the same
 * weight.
 */
function embeddingPhrase(e: EmbeddingRecap): string {
  if (e.backendDisabled) {
    return (
      `[embedding].backend is disabled, so the ${e.ingested} source(s) this sync ingested have ` +
      "no vectors — full-text search covers them, semantic search does not. A later sync only " +
      "embeds new or changed sources, so after enabling a backend run " +
      `\`suasor embeddings drain\` once to cover these (${docsUrl("guide/embedding.md")})`
    );
  }
  const pending = e.ingested - e.embedded;
  return (
    `${e.embedded} of ${e.ingested} ingested source(s) embedded — the other ${pending} have no ` +
    "vector and a later sync will not retry them (it only embeds new or changed sources); " +
    "run `suasor embeddings drain` once the sidecar is reachable"
  );
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

  // Pointer, not a restatement: the `warning:` lines carry what each advisory
  // says and how to fix it, and those two advisories differ in both severity and
  // remedy ("runs and ingests nothing" vs "cannot reach its API"), so folding
  // them into one recap sentence would flatten that difference. The pointer names
  // the *stream* rather than saying "above": the recap is stdout and the
  // advisories are stderr, so "above" is only true when both are on a terminal.
  const configWarnings = input.configWarnings ?? [];
  if (configWarnings.length > 0) {
    lines.push(
      `  config: ${configWarnings.length} pre-sync warning(s) for ${configWarnings.join(", ")} — ` +
        "see the `warning:` line(s) on stderr",
    );
  }

  // Stated, never inferred from the config: the sync's own counters are what say
  // whether a vector was written, and they are also what the wizard would have to
  // contradict to claim the corpus is searchable semantically.
  if (input.embeddings) {
    lines.push(`  embeddings: ${embeddingPhrase(input.embeddings)}.`);
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
  } else if (configWarnings.length > 0) {
    // A sync that exits 0 having ingested nothing is the failure #187 is about;
    // closing with a bare "Setup complete." would be the wizard's own version of
    // it.
    lines.push(
      `Setup complete, but ${configWarnings.length} pre-sync config warning(s) are unresolved.`,
    );
  } else {
    lines.push("Setup complete.");
  }
  return lines.join("\n");
}
