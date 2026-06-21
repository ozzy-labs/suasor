/**
 * Invocation-channel detection + note rendering for `suasor onboard` step 6
 * (ADR-0029 §5, Issue #293).
 *
 * The scheduler / cron / MCP templates the wizard prints assume a global
 * `suasor` on PATH. From source (`bun run src/index.ts`) or via `bunx` no such
 * binary exists, so the printed template would produce a non-runnable scheduler
 * entry. We can't reliably synthesise an absolute invocation for every channel,
 * so the wizard detects the *likely* channel (a heuristic, OS/argv injected for
 * testability) and prints a note telling the user to substitute the correct
 * invocation when they are not running a global install.
 */

/** How the running `suasor` process was most likely invoked. */
export type InvocationChannel = "global" | "from-source" | "bunx";

/**
 * Heuristically classify the invocation channel from `process.argv` /
 * `process.execPath`. Both are injected so the heuristic is unit-testable.
 *
 * - `from-source`: argv[1] points at a `.ts` / `.mts` entry (e.g. `src/index.ts`)
 *   or execPath is the `bun` runtime running a source entry.
 * - `bunx`: argv[1] resolves under a bun/npm cache dir (`.bun/install/cache`,
 *   `node_modules/.bin` invoked transiently).
 * - `global`: anything else (a real `suasor` on PATH) — the default the
 *   templates already assume.
 */
export function detectInvocationChannel(
  argv: readonly string[],
  execPath: string,
): InvocationChannel {
  const entry = argv[1] ?? "";
  if (/\.(m?ts)$/.test(entry)) return "from-source";
  if (/[\\/](\.bun|\.cache[\\/]\.bun)[\\/]/.test(entry) || /[\\/]bunx[\\/]/.test(entry)) {
    return "bunx";
  }
  // A bun runtime running a non-.ts entry under a cache dir is bunx-shaped too.
  if (/[\\/]bun(\.exe)?$/.test(execPath) && /[\\/](\.bun|cache)[\\/]/.test(entry)) {
    return "bunx";
  }
  return "global";
}

/**
 * The note appended to the scheduler / cron / MCP output. For a global install
 * it confirms the template is ready to use as-is; for from-source / bunx it
 * warns that `suasor` is not on PATH and the invocation must be substituted.
 */
export function invocationNote(channel: InvocationChannel): string {
  if (channel === "from-source") {
    return [
      "Note: you appear to be running from source — `suasor` is not on PATH.",
      "Replace `suasor` in the template above with your real invocation",
      "(e.g. `bun run /abs/path/to/src/index.ts`) before installing the scheduler entry.",
    ].join("\n");
  }
  if (channel === "bunx") {
    return [
      "Note: you appear to be running via bunx — `suasor` is not on PATH.",
      "Replace `suasor` in the template above with `bunx suasor`",
      "(or install globally) before installing the scheduler entry.",
    ].join("\n");
  }
  return "Note: the template assumes a global `suasor` on PATH (ready to use as-is).";
}
