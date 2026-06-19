/**
 * Human-readable formatting for Slack timestamps in the operational CLI
 * (`slack status`, `slack conversations`). Issue #84 / track ③ UX parity.
 *
 * Slack `ts` values are epoch seconds with a microsecond fraction encoded as a
 * string (e.g. `"1718800000.001200"`). The cursor map and engagement axis carry
 * these raw values; the table output used to print them verbatim, leaving an
 * operator unable to tell *when* a channel was last synced. This renders a raw
 * `ts` as `YYYY-MM-DD HH:MM (<relative>)` for the human-facing columns, while the
 * `--json` paths keep the raw value untouched (backward compatible).
 *
 * `now` is injectable so the relative phrasing is deterministic under test.
 */

/** Two-digit zero pad for the date/time fields. */
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Parse a Slack `ts` (epoch seconds, possibly with a `.microseconds` fraction)
 * to milliseconds since the epoch, or `null` when it is not a finite number.
 */
export function parseSlackTsMs(ts: string): number | null {
  const seconds = Number.parseFloat(ts);
  if (!Number.isFinite(seconds)) return null;
  return Math.round(seconds * 1000);
}

/** Render a millisecond instant as `YYYY-MM-DD HH:MM` in the local timezone. */
function formatLocal(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  );
}

/**
 * Phrase the gap between `ms` and `nowMs` as a coarse relative string:
 * `just now`, `N minutes ago`, `N hours ago`, `N days ago`, or for the future
 * (clock skew / index lag) the symmetric `in N …`. Singular/plural aware.
 */
export function relativeTime(ms: number, nowMs: number): string {
  const diff = nowMs - ms;
  const future = diff < 0;
  const abs = Math.abs(diff);
  const unit = (value: number, name: string): string => {
    const label = `${value} ${name}${value === 1 ? "" : "s"}`;
    return future ? `in ${label}` : `${label} ago`;
  };
  const minutes = Math.floor(abs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return unit(minutes, "minute");
  const hours = Math.floor(abs / 3_600_000);
  if (hours < 24) return unit(hours, "hour");
  const days = Math.floor(abs / 86_400_000);
  return unit(days, "day");
}

/**
 * Format a raw Slack `ts` as `YYYY-MM-DD HH:MM (<relative>)` for human-facing
 * CLI columns. Returns the raw value unchanged when it does not parse as a
 * number, so an unexpected cursor value is still shown rather than swallowed.
 */
export function formatSlackTs(ts: string, now: () => number = () => Date.now()): string {
  const ms = parseSlackTsMs(ts);
  if (ms === null) return ts;
  return `${formatLocal(ms)} (${relativeTime(ms, now())})`;
}
