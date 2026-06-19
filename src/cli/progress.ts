/**
 * Minimal progress indicator for long-running CLI work (opshub ADR-0026 parity).
 *
 * Long syncs (`<connector> sync`) used to run silently until the final summary,
 * so an operator could not tell a slow sync from a hung one. This renders an
 * indeterminate "processed N" counter on a stream (stderr) so stdout stays
 * pipe-clean. It is a **no-op when the stream is not a TTY** (CI / pipes /
 * redirects) so no ANSI escapes leak into captured output, and CLI tests that
 * assert on stdout keep passing unchanged.
 */

/** The subset of a writable stream this needs (stderr-shaped). */
export interface ProgressStream {
  write(s: string): boolean;
  isTTY?: boolean;
}

export interface Progress {
  /** Count one processed item (renders, throttled). */
  tick(): void;
  /** Clear the progress line — call before the final stdout summary. */
  finish(): void;
}

const CLEAR_LINE = "\r\x1b[2K";
/** Render at most ~12 fps so a fast stream isn't flooded with redraws. */
const RENDER_INTERVAL_MS = 80;

/**
 * Create a progress reporter on `stream` labelled `label`. Disabled (all methods
 * no-op) when the stream is not a TTY, or when `enabled` is explicitly `false`.
 * `now` is injectable for deterministic throttling tests.
 */
export function createProgress(
  stream: ProgressStream,
  label: string,
  enabled?: boolean,
  now: () => number = () => Date.now(),
): Progress {
  const on = enabled ?? stream.isTTY === true;
  if (!on) return { tick() {}, finish() {} };

  let count = 0;
  let lastRender = 0;
  return {
    tick() {
      count += 1;
      const t = now();
      if (t - lastRender >= RENDER_INTERVAL_MS) {
        stream.write(`${CLEAR_LINE}${label}: ${count} processed…`);
        lastRender = t;
      }
    },
    finish() {
      stream.write(CLEAR_LINE);
    },
  };
}
