/**
 * Pure helpers for the `suasor onboard` interactive connector selection
 * (ADR-0029 §2, Issue #293).
 *
 * The wizard's TTY prompt is split into a pure "candidates → selection" resolver
 * so the selection logic is unit-testable with injected input (no real TTY).
 * The CLI layer only owns rendering the menu and reading a line from stdin; the
 * parsing/validation of what the user typed lives here.
 */

/** The rendered, numbered menu shown before reading the user's selection. */
export function renderConnectorMenu(candidates: readonly string[]): string {
  const lines = candidates.map((name, i) => `  ${i + 1}) ${name}`);
  return [
    "Select connector(s) to set up.",
    "Enter numbers and/or names, separated by commas or spaces (e.g. `1,3` or `github slack`):",
    ...lines,
    "",
  ].join("\n");
}

/**
 * Resolve a raw selection line (numbers and/or names, comma/space separated)
 * against the candidate list into a deduplicated connector list.
 *
 * - Numbers are 1-based indices into `candidates`.
 * - Names must match a candidate exactly.
 * - Order follows the user's input; duplicates are removed (first wins).
 *
 * Returns `{ error }` for an empty selection, an out-of-range index, or an
 * unknown name (no silent wrong answer, ADR-0007).
 */
export function resolveSelection(
  raw: string,
  candidates: readonly string[],
): { connectors: string[] } | { error: string } {
  const tokens = raw
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return { error: "no connector selected" };

  const known = new Set(candidates);
  const out: string[] = [];
  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      const index = Number.parseInt(token, 10) - 1;
      if (index < 0 || index >= candidates.length) {
        return { error: `selection out of range: ${token} (choose 1-${candidates.length})` };
      }
      const name = candidates[index];
      if (name !== undefined && !out.includes(name)) out.push(name);
      continue;
    }
    if (!known.has(token)) {
      return { error: `unknown connector: ${token} (known: ${candidates.join(", ")})` };
    }
    if (!out.includes(token)) out.push(token);
  }
  return { connectors: out };
}
