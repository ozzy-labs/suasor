/**
 * Non-destructive `[connectors.<name>]` slice appender for `suasor onboard`
 * (ADR-0029 §3). The onboarding wizard's only new side effect is writing an
 * `enabled = true` connector slice into `config.toml` — the structural fix for
 * the "`auth set` succeeded but sync stays silent" gap (a stored token does
 * nothing until the slice exists and is not `enabled = false`, ADR-0027).
 *
 * Pure string-in / string-out so it is directly unit-testable (idempotent /
 * non-destructive / new-append). It deliberately **does not** round-trip the
 * TOML through a parser: Bun's `TOML.parse` drops comments, key order, and
 * formatting, which would clobber the user's hand-written config. Instead it
 * detects an existing `[connectors.<name>]` header by line scan and, when
 * absent, appends a minimal slice at the end of the file. Existing sections —
 * including a user's `enabled = false` — are never rewritten.
 *
 * The same three guarantees (line scan, tail append, never rewrite) extend one
 * level down to the per-account tables `[connectors.<name>.accounts.<account>]`
 * (ADR-0050), which is how the wizard configures a second account (Issue #538).
 */

import { type ConnectorSliceTemplate, connectorManifest } from "../../connectors/manifest.ts";

/**
 * A minimal connector-slice template. Re-exported from the connector manifest
 * module (Issue #440), which is now the SSOT for the per-connector templates —
 * they live on `ConnectorManifest.sliceTemplate` alongside the rest of each
 * connector's platform knowledge, and connectors never depend on the `cli` layer.
 */
export type { ConnectorSliceTemplate } from "../../connectors/manifest.ts";

/**
 * Build the default slice template for a connector from its manifest (falls back
 * to `enabled = true` only for an unknown / template-less connector). `enabled =
 * true` is the load-bearing line — without it `suasor sync` silently skips the
 * connector.
 */
export function connectorSliceTemplate(connector: string): ConnectorSliceTemplate {
  return connectorManifest(connector)?.sliceTemplate ?? { body: ["enabled = true"] };
}

/**
 * Whether a `[connectors.<name>]` header already exists in the TOML text.
 *
 * Matches the header by line (ignoring surrounding whitespace), tolerating
 * inline comments after the closing bracket. Does **not** match nested tables
 * like `[connectors.slack.workspaces.foo]` — only the connector's own slice.
 */
export function hasConnectorSlice(toml: string, connector: string): boolean {
  return hasHeader(toml, `[connectors.${connector}]`);
}

/** Whether an exact table header line exists in the TOML text (comments ignored). */
function hasHeader(toml: string, header: string): boolean {
  for (const raw of toml.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#")) continue;
    // Match the exact header, optionally followed by an inline comment.
    if (line === header || line.startsWith(`${header} #`) || line.startsWith(`${header}\t`)) {
      return true;
    }
  }
  return false;
}

/** The `[connectors.<name>.accounts.<account>]` header for a per-account table (ADR-0050). */
export function accountSliceHeader(connector: string, account: string): string {
  return `[connectors.${connector}.accounts.${account}]`;
}

/**
 * Whether a `[connectors.<name>.accounts.<account>]` header already exists
 * (ADR-0050). The counterpart of {@link hasConnectorSlice} one level down: the
 * flat check deliberately does *not* match nested tables, so adding an account
 * needs its own probe.
 */
export function hasConnectorAccountSlice(
  toml: string,
  connector: string,
  account: string,
): boolean {
  return hasHeader(toml, accountSliceHeader(connector, account));
}

/**
 * Append a `[connectors.<name>.accounts.<account>]` table with `body` if (and
 * only if) that account's table is absent (ADR-0050 決定 2).
 *
 * Same non-destructive guarantee as {@link appendConnectorSlice}: an account the
 * operator already wrote — including one they edited — is left untouched
 * (`appended: false`). `body` carries the table's lines **without** the header.
 */
export function appendConnectorAccountSlice(
  toml: string,
  connector: string,
  account: string,
  body: readonly string[],
): AppendResult {
  if (hasConnectorAccountSlice(toml, connector, account)) {
    return { toml, appended: false };
  }
  return appendBlock(toml, [accountSliceHeader(connector, account), ...body]);
}

/**
 * Turn a discovery-rendered `[connectors.<name>]` block into the **body** of an
 * account table (ADR-0050 + ADR-0030): drop the flat header, and drop `enabled`.
 *
 * `enabled` is dropped because it is read at the connector level only
 * (`selectEnabledConnectors` inspects `config.connectors[name].enabled`); nothing
 * resolves it per account. Copying it into the account table would ship a key an
 * operator could set and nothing would ever read — the "don't hand out structure
 * nobody reads" rule ADR-0049 決定 3 applies to config surfaces too.
 */
export function accountBodyFromBlock(connector: string, blockLines: readonly string[]): string[] {
  const header = `[connectors.${connector}]`;
  return blockLines.filter((raw) => {
    const line = raw.trim();
    return line !== header && !/^enabled\s*=/.test(line);
  });
}

/**
 * Body for an account table the wizard could not populate from discovery.
 *
 * It states the two facts an operator cannot see from the table itself: that the
 * empty table inherits the flat keys, and that the inherited *ingest-scope* keys
 * name objects inside a **different** account (a Box folder id or a Google
 * calendar id from the first account addresses nothing here — the very reason
 * these connectors name their accounts, ADR-0050 決定 1).
 */
export function connectorAccountTemplate(connector: string): string[] {
  return [
    `# Inherits every [connectors.${connector}] key this table does not override.`,
    "# Ingest-scope keys are account-relative: ids inherited from the flat table",
    "# belong to another account, so set this account's own ids here.",
  ];
}

/**
 * Body for the explicit `[connectors.<name>.accounts.default]` table the wizard
 * writes when it adds the *first named* account to a config that was already
 * syncing flat (ADR-0050 決定 3).
 *
 * Empty but for the comment: `default` is the account whose secrets and external
 * ids stay unprefixed, so spelling it out changes nothing about the install — it
 * only stops the flat keys from being demoted to inheritance-defaults-only by
 * the very table the wizard is about to add.
 */
export function connectorDefaultAccountTemplate(connector: string): string[] {
  return [
    `# The account that was already syncing as flat [connectors.${connector}] keys.`,
    "# Empty on purpose: it inherits those keys, and keeps its unprefixed keychain",
    "# entry and external ids (ADR-0050). Without it, adding a named account would",
    "# turn the flat keys into inheritance defaults and stop ingesting this one.",
  ];
}

/** Result of an append attempt. */
export interface AppendResult {
  /** The (possibly unchanged) TOML text. */
  readonly toml: string;
  /** Whether a new slice was actually appended (false = already present). */
  readonly appended: boolean;
}

/**
 * Append a `[connectors.<name>]` slice to `toml` if (and only if) it is absent.
 *
 * Idempotent and non-destructive: an existing slice — including one a user set
 * to `enabled = false` — is left untouched (`appended: false`). When appended,
 * the new slice is separated from prior content by a blank line, and the file
 * ends with a single trailing newline.
 */
export function appendConnectorSlice(toml: string, connector: string): AppendResult {
  if (hasConnectorSlice(toml, connector)) {
    return { toml, appended: false };
  }

  const template = connectorSliceTemplate(connector);
  const sliceLines = [`[connectors.${connector}]`, ...template.body];
  return appendBlock(toml, sliceLines);
}

/**
 * Append a **pre-rendered** `[connectors.<name>]` block to `toml` if (and only
 * if) a slice for `connector` is absent — the discovery path's counterpart to
 * {@link appendConnectorSlice} (ADR-0030 / ADR-0029, Issue #195).
 *
 * Where {@link appendConnectorSlice} synthesizes a minimal placeholder slice,
 * this appends a block already rendered from discovery (`renderConnectorConfigBlock`
 * via a connector's `discover()` probe), so an `onboard` of a discovery-capable
 * connector lands the discovered ids — not just `enabled = true` — into the
 * config. Same non-destructive guarantee: an existing `[connectors.<name>]`
 * (including a user's `enabled = false`) is left untouched (`appended: false`).
 *
 * `blockLines` must be a self-contained slice whose first line is the
 * `[connectors.<name>]` header (the shape `renderConnectorConfigBlock` returns);
 * it is appended verbatim, separated by a single blank line, ending on one
 * trailing newline.
 */
export function appendConnectorBlock(
  toml: string,
  connector: string,
  blockLines: readonly string[],
): AppendResult {
  if (hasConnectorSlice(toml, connector)) {
    return { toml, appended: false };
  }
  return appendBlock(toml, blockLines);
}

/** Append `lines` as a block, normalizing surrounding whitespace. */
function appendBlock(toml: string, lines: readonly string[]): AppendResult {
  const slice = lines.join("\n");
  // Normalize the existing trailing whitespace so we always insert exactly one
  // blank line before the new slice and end on a single newline.
  const base = toml.replace(/\s*$/, "");
  const next = base.length === 0 ? `${slice}\n` : `${base}\n\n${slice}\n`;
  return { toml: next, appended: true };
}
