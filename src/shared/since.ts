/**
 * Shared `--since` / `--until` duration-or-ISO parser (Issue #561).
 *
 * Time-filtered CLI verbs grew three `--since` dialects: `brief` accepted
 * `24h`/`7d`/`2w`/ISO, `slack cursor backfill` had its own equivalent parser,
 * and `source list` / `search` forwarded raw strings into SQL `observed_at`
 * comparisons — so `--since 7d` (the exact syntax `brief` teaches) lexically
 * compared `"7d" > "2026-…"` and silently printed "No sources." with exit 0,
 * violating ADR-0007's "no silent wrong answer". This module is the single
 * parser every time-filter flag goes through: a relative duration (`24h` /
 * `7d` / `2w`) or an absolute ISO date / datetime, with unparseable input
 * rejected as `null` so callers can fail fast.
 *
 * Lives in `src/shared` (not `src/cli`) so the connector layer can reuse the
 * same syntax without a dependency inversion onto the CLI (cf. `doc-ref.ts`).
 * Pure and dependency-free (import-clean, NFR-PRF-1).
 */

/** `<n><unit>` relative-duration syntax (h/d/w). */
const RELATIVE_SINCE = /^(\d+)([hdw])$/;
const UNIT_MS: Record<string, number> = { h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/**
 * Human-readable syntax hint for error messages, so every verb rejects
 * unparseable time filters with the same wording.
 */
export const SINCE_SYNTAX_HINT = "a duration (24h / 7d / 2w) or ISO date";

/**
 * Parse a time-filter value to milliseconds since the epoch: a relative
 * `24h` / `7d` / `2w` (before `nowMs`) or an absolute ISO date / datetime.
 * Returns `null` when it parses as neither.
 */
export function parseSinceMs(value: string, nowMs: number): number | null {
  const rel = RELATIVE_SINCE.exec(value.trim());
  if (rel) {
    const amount = Number(rel[1]);
    const unit = UNIT_MS[rel[2] as string] as number;
    return nowMs - amount * unit;
  }
  const parsed = Date.parse(value.trim());
  if (Number.isNaN(parsed)) return null;
  return parsed;
}

/**
 * Resolve a time-filter value to an ISO 8601 instant (the projection tables
 * store zero-padded UTC timestamps, so bounds compare lexicographically), or
 * `null` when unparseable. Exported for unit testing.
 */
export function resolveSince(value: string, nowMs: number): string | null {
  const ms = parseSinceMs(value, nowMs);
  if (ms === null) return null;
  return new Date(ms).toISOString();
}
