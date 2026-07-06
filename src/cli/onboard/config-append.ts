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
  const header = `[connectors.${connector}]`;
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
