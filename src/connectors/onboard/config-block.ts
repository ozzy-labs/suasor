/**
 * Shared `[connectors.<name>]` config-block renderer for connector **discovery**
 * verbs (ADR-0030). A discovery verb (e.g. `github repos`) enumerates the ids a
 * token can see and prints a paste-ready slice so the operator never hand-hunts
 * an id — the same seam `slack conversations` opened (ADR-0011), generalized.
 *
 * This *generates* the candidate text; appending it to `config.toml` is a
 * separate, non-destructive concern (`appendConnectorSlice`, ADR-0029). The two
 * emit the same minimal slice shape (a leading `enabled = true`) so a discovery
 * block and an onboard append stay consistent.
 *
 * Pure string-in / string-out so it is directly unit-testable, and free of any
 * connector SDK (import-clean, ADR-0007 / NFR-PRF-1).
 */

/** One discovered id row to render into a quoted array entry. */
export interface ConfigBlockEntry {
  /** The value to keep (the id / full name the connector config expects). */
  readonly value: string;
  /** Human-readable label rendered as a trailing `# <label>` comment (optional). */
  readonly label?: string;
}

/** Options for {@link renderConnectorConfigBlock}. */
export interface RenderConfigBlockOptions {
  /**
   * The config key the discovered ids populate (e.g. `repos`, `channels`). The
   * entries render as a `<key> = [ ... ]` array; `[]` when there are none.
   */
  readonly key: string;
  /**
   * Extra body lines emitted between `enabled = true` and the array (e.g. a
   * `team = "T123"` line, or a one-line note explaining ids vs names). Rendered
   * verbatim, in order.
   */
  readonly extras?: readonly string[];
  /**
   * A note rendered as a `#` comment just above the array, clarifying that the
   * quoted values are ids and the `#` comments are labels only (the values are
   * what sync reads — a name silently ingests nothing). Omitted when absent.
   */
  readonly idNote?: string;
}

/**
 * Render a paste-ready `[connectors.<name>]` slice from discovered entries.
 *
 * The slice always begins `[connectors.<name>]` + `enabled = true` (the
 * load-bearing line — without it `suasor sync` silently skips the connector,
 * ADR-0027 / ADR-0029), followed by any `extras`, then the `<key> = [ ... ]`
 * array. Each entry renders as a quoted value with an optional trailing
 * `# <label>` comment. With no entries the array renders empty (`<key> = []`).
 *
 * Returns the lines (no trailing newline) so callers control output framing.
 */
export function renderConnectorConfigBlock(
  connector: string,
  entries: readonly ConfigBlockEntry[],
  options: RenderConfigBlockOptions,
): string[] {
  const lines = [`[connectors.${connector}]`, "enabled = true"];
  for (const extra of options.extras ?? []) {
    lines.push(extra);
  }
  if (entries.length === 0) {
    lines.push(`${options.key} = []`);
    return lines;
  }
  if (options.idNote) {
    lines.push(`# ${options.idNote}`);
  }
  lines.push(`${options.key} = [`);
  for (const entry of entries) {
    const comment = entry.label ? `,  # ${entry.label}` : ",";
    lines.push(`  "${entry.value}"${comment}`);
  }
  lines.push("]");
  return lines;
}
