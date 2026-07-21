/**
 * Surgical `channels` edits for the flat `[connectors.slack]` config section
 * (`slack follow` / `slack unfollow`, ADR-0042 決定 6).
 *
 * The edit is **text-based**, not parse-and-reserialize: re-emitting the whole
 * TOML would drop the operator's comments and formatting everywhere else in
 * `config.toml`. Instead the section's `channels = [...]` array alone is
 * rewritten — existing entry lines are kept **verbatim** (their `# name`
 * comments survive), added ids append as `  "<id>",  # <label>` lines, and
 * removed ids drop their line. A single-line array (`channels = ["C1"]`) is
 * converted to the multi-line form on first edit.
 *
 * Safety: every edit round-trips the result through `Bun.TOML.parse` before it
 * is returned — a malformed result throws instead of corrupting the config.
 * Ids are matched exactly (the id is the truth; names are display only).
 */

/** One channel entry to add: the id (truth) plus an optional display label. */
export interface ChannelEntry {
  readonly id: string;
  /** Human label appended as a `# <label>` comment (display only). */
  readonly label?: string;
}

/** Outcome of an add edit. */
export interface AddChannelsResult {
  readonly toml: string;
  /** Ids actually appended (order preserved). */
  readonly added: string[];
  /** Ids skipped because they were already configured. */
  readonly already: string[];
}

/** Outcome of a remove edit. */
export interface RemoveChannelsResult {
  readonly toml: string;
  /** Ids actually removed. */
  readonly removed: string[];
  /** Ids that were not in the configured list. */
  readonly missing: string[];
}

/** Matches the `[connectors.slack]` section header line (exact table only). */
const SECTION_HEADER = /^\s*\[connectors\.slack\]\s*(?:#.*)?$/;
/** Matches any TOML table header line (starts a new section). */
const ANY_HEADER = /^\s*\[/;
/** Matches the start of the `channels` key inside the section. */
const CHANNELS_KEY = /^\s*channels\s*=\s*\[/;
/** Extracts every quoted string from a line (the array's id entries). */
const QUOTED = /"((?:[^"\\]|\\.)*)"/g;

/** The `[connectors.slack]` section's line span: [headerIdx, endIdx) (end exclusive). */
function sectionSpan(lines: string[]): { header: number; end: number } | null {
  const header = lines.findIndex((l) => SECTION_HEADER.test(l));
  if (header < 0) return null;
  let end = lines.length;
  for (let i = header + 1; i < lines.length; i++) {
    if (ANY_HEADER.test(lines[i] as string)) {
      end = i;
      break;
    }
  }
  return { header, end };
}

/**
 * The `channels = [...]` array's line span inside the section: `[start, stop]`
 * (both inclusive; `start === stop` for a single-line array), or `null` when the
 * key is absent.
 */
function channelsSpan(
  lines: string[],
  section: { header: number; end: number },
): { start: number; stop: number } | null {
  for (let i = section.header + 1; i < section.end; i++) {
    const line = lines[i] as string;
    if (!CHANNELS_KEY.test(line)) continue;
    // Single-line array: the closing bracket sits on the same line (comments
    // after `]` are fine; a `]` inside a quoted id cannot occur in a Slack id).
    if (/\]/.test(line.replace(QUOTED, '""'))) return { start: i, stop: i };
    for (let j = i + 1; j < section.end; j++) {
      if (/^\s*\]/.test(lines[j] as string)) return { start: i, stop: j };
    }
    return null; // unterminated array — let the TOML round-trip below reject it
  }
  return null;
}

/** Every quoted id found in the given line span (order preserved). */
function idsInSpan(lines: string[], start: number, stop: number): string[] {
  const out: string[] = [];
  for (let i = start; i <= stop; i++) {
    for (const m of (lines[i] as string).matchAll(QUOTED)) out.push(m[1] as string);
  }
  return out;
}

/** Render one multi-line array entry: `  "<id>",  # <label>`. */
function entryLine(entry: ChannelEntry): string {
  return `  "${entry.id}",${entry.label ? `  # ${entry.label}` : ""}`;
}

/** Round-trip guard: throw when the edited text no longer parses as TOML. */
function assertParses(toml: string): void {
  try {
    Bun.TOML.parse(toml);
  } catch (cause) {
    throw new Error(
      `internal error: the channels edit produced invalid TOML — config left untouched (${
        cause instanceof Error ? cause.message : String(cause)
      })`,
    );
  }
}

/**
 * Append channel ids to `[connectors.slack].channels`, creating the section /
 * key when absent. Already-configured ids are skipped (reported in `already`).
 */
export function addSlackChannels(
  toml: string,
  entries: readonly ChannelEntry[],
): AddChannelsResult {
  const lines = toml.split("\n");
  const section = sectionSpan(lines);

  // No [connectors.slack] at all → append a fresh enabled section.
  if (section === null) {
    const block = [
      "",
      "[connectors.slack]",
      "enabled = true",
      "channels = [",
      ...entries.map(entryLine),
      "]",
    ];
    const joined = `${toml.replace(/\n*$/, "\n")}${block.join("\n").replace(/^\n/, "")}\n`;
    assertParses(joined);
    return { toml: joined, added: entries.map((e) => e.id), already: [] };
  }

  const span = channelsSpan(lines, section);

  // Section exists but no channels key → insert a fresh array right after the
  // header (before any sub-tables, which `sectionSpan` already excludes).
  if (span === null) {
    const inserted = ["channels = [", ...entries.map(entryLine), "]"];
    lines.splice(section.header + 1, 0, ...inserted);
    const joined = lines.join("\n");
    assertParses(joined);
    return { toml: joined, added: entries.map((e) => e.id), already: [] };
  }

  const existing = new Set(idsInSpan(lines, span.start, span.stop));
  const added = entries.filter((e) => !existing.has(e.id));
  const already = entries.filter((e) => existing.has(e.id)).map((e) => e.id);
  if (added.length === 0) {
    return { toml, added: [], already };
  }

  if (span.start === span.stop) {
    // Single-line array → convert to multi-line, preserving existing ids (their
    // inline comments, if any, live after `]` and are kept on the closer line).
    const line = lines[span.start] as string;
    const indentMatch = /^\s*/.exec(line);
    const indent = indentMatch ? indentMatch[0] : "";
    const afterCloser = line.slice(line.indexOf("]") + 1); // trailing comment etc.
    const existingIds = idsInSpan(lines, span.start, span.stop);
    const rebuilt = [
      `${indent}channels = [`,
      ...existingIds.map((id) => `  "${id}",`),
      ...added.map(entryLine),
      `${indent}]${afterCloser}`,
    ];
    lines.splice(span.start, 1, ...rebuilt);
  } else {
    // Multi-line array → append the new entry lines just before the closer.
    lines.splice(span.stop, 0, ...added.map(entryLine));
  }
  const joined = lines.join("\n");
  assertParses(joined);
  return { toml: joined, added: added.map((e) => e.id), already };
}

/**
 * Remove channel ids from `[connectors.slack].channels`. Entry lines whose only
 * id matches are dropped whole (their comment goes with them); a line carrying
 * several ids (single-line style) keeps the survivors.
 */
export function removeSlackChannels(toml: string, ids: readonly string[]): RemoveChannelsResult {
  const lines = toml.split("\n");
  const section = sectionSpan(lines);
  const wanted = new Set(ids);
  if (section === null) {
    return { toml, removed: [], missing: [...ids] };
  }
  const span = channelsSpan(lines, section);
  if (span === null) {
    return { toml, removed: [], missing: [...ids] };
  }

  const present = new Set(idsInSpan(lines, span.start, span.stop));
  const removed = ids.filter((id) => present.has(id));
  const missing = ids.filter((id) => !present.has(id));
  if (removed.length === 0) {
    return { toml, removed: [], missing };
  }

  if (span.start === span.stop) {
    // Single-line array: rebuild the id list minus the removed ones.
    const line = lines[span.start] as string;
    const indentMatch = /^\s*/.exec(line);
    const indent = indentMatch ? indentMatch[0] : "";
    const afterCloser = line.slice(line.indexOf("]") + 1);
    const survivors = idsInSpan(lines, span.start, span.stop).filter((id) => !wanted.has(id));
    lines[span.start] =
      `${indent}channels = [${survivors.map((id) => `"${id}"`).join(", ")}]${afterCloser}`;
  } else {
    // Multi-line array: drop each entry line whose ids are all removed; keep
    // survivors verbatim (comments intact).
    for (let i = span.stop - 1; i > span.start; i--) {
      const lineIds = idsInSpan(lines, i, i);
      if (lineIds.length > 0 && lineIds.every((id) => wanted.has(id))) {
        lines.splice(i, 1);
      }
    }
  }
  const joined = lines.join("\n");
  assertParses(joined);
  return { toml: joined, removed, missing };
}
