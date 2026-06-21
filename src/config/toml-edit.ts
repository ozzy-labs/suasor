/**
 * Minimal, surgical TOML edits for `validate-config --fix` (Issue #280).
 *
 * The safe-fix policy only ever *removes* things (unknown/typo keys, dangling
 * local roots — see validate.ts). Re-serializing the whole tree would discard
 * the user's comments and formatting, which is hostile for a hand-maintained
 * config. Instead we edit the original TOML *text* line-by-line, removing only
 * the offending lines, so everything else (comments, ordering, spacing) is left
 * exactly as written.
 *
 * Scope is intentionally tiny — it understands just enough TOML to find a
 * `key = ...` line within a `[table]` / `[a.b]` section, and to drop a quoted
 * string element from an inline or multi-line array. It is not a general TOML
 * editor; it handles exactly the shapes the fixer emits removals for and leaves
 * anything it cannot match untouched (returning `changed: false`).
 */

/** Result of a text edit pass. */
export interface TomlEditResult {
  /** The edited TOML text. */
  text: string;
  /** Whether any line was actually removed. */
  changed: boolean;
}

/** A `[section.header]` line (captures the dotted path inside the brackets). */
const SECTION_RE = /^\s*\[([^[\]]+)\]\s*(#.*)?$/;
/** A `key = value` line (captures the bare key before `=`). */
const KEY_RE = /^\s*([A-Za-z0-9_-]+)\s*=/;

/** Split a dotted config path into [sectionPath, leafKey]. */
function splitPath(dotted: string): { section: string; key: string } {
  const parts = dotted.split(".");
  const key = parts.pop() as string;
  return { section: parts.join("."), key };
}

/** Parse a `[...]` header's dotted path (bare or quoted segments). */
function sectionOf(line: string): string | null {
  const m = SECTION_RE.exec(line);
  return m?.[1] !== undefined ? m[1].trim() : null;
}

/**
 * Remove the `key = ...` line for `dotted` (e.g. `connectors.github.repo`),
 * matching it only inside its owning `[connectors.github]` section. Multi-line
 * array values for the key are removed in full (from the `key =` line through
 * the closing `]`). No-op (changed: false) when the key is not found.
 */
export function removeKeyLine(text: string, dotted: string): TomlEditResult {
  const { section, key } = splitPath(dotted);
  const lines = text.split("\n");
  const out: string[] = [];
  let current = ""; // current section path ("" = root table)
  let changed = false;
  let skipUntilArrayClose = false;

  for (const line of lines) {
    if (skipUntilArrayClose) {
      if (/]\s*(#.*)?$/.test(line)) skipUntilArrayClose = false;
      continue;
    }
    const header = sectionOf(line);
    if (header !== null) {
      current = header;
      out.push(line);
      continue;
    }
    const km = KEY_RE.exec(line);
    if (km && current === section && km[1] === key) {
      changed = true;
      // If the value opens a multi-line array (no closing `]` on this line),
      // swallow subsequent lines until the array closes.
      const afterEq = line.slice(line.indexOf("=") + 1);
      const opensArray = afterEq.includes("[") && !/]\s*(#.*)?$/.test(line);
      if (opensArray) skipUntilArrayClose = true;
      continue; // drop this line
    }
    out.push(line);
  }

  return { text: out.join("\n"), changed };
}

/**
 * Remove the quoted string element `value` from the array assigned to `dotted`,
 * whether the array is inline (`roots = ["a", "b"]`) or multi-line. Matches the
 * element by its string value (the only thing the dangling-root fixer needs).
 * No-op when not found.
 */
export function removeArrayElement(text: string, dotted: string, value: string): TomlEditResult {
  const { section, key } = splitPath(dotted);
  const lines = text.split("\n");
  const out: string[] = [];
  let current = "";
  let changed = false;
  let inTargetArray = false;

  const elementMatches = (segment: string): boolean => {
    // Compare the quoted literal, tolerating single or double quotes + spacing.
    const quoted = segment.trim().replace(/,$/, "").trim();
    return quoted === JSON.stringify(value) || quoted === `'${value}'`;
  };

  for (const line of lines) {
    const header = sectionOf(line);
    if (header !== null) {
      current = header;
      inTargetArray = false;
      out.push(line);
      continue;
    }

    const km = KEY_RE.exec(line);
    if (km && current === section && km[1] === key) {
      // Inline array on one line: strip the element in place.
      const eq = line.indexOf("=");
      const lhs = line.slice(0, eq + 1);
      const rhs = line.slice(eq + 1);
      if (rhs.includes("[") && /]/.test(rhs)) {
        const inner = rhs.slice(rhs.indexOf("[") + 1, rhs.lastIndexOf("]"));
        const elems = inner
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        const kept = elems.filter((e) => !elementMatches(e));
        if (kept.length !== elems.length) changed = true;
        out.push(`${lhs} [${kept.join(", ")}]`);
        continue;
      }
      // Multi-line array opens here; keep this line and scan elements below.
      inTargetArray = true;
      out.push(line);
      continue;
    }

    if (inTargetArray) {
      if (/]\s*(#.*)?$/.test(line) && !line.includes('"') && !line.includes("'")) {
        inTargetArray = false; // closing bracket line
        out.push(line);
        continue;
      }
      if (elementMatches(line)) {
        changed = true;
        continue; // drop the element line
      }
      out.push(line);
      continue;
    }

    out.push(line);
  }

  return { text: out.join("\n"), changed };
}
