/**
 * Bun runtime guard. Suasor is an *application* that runs on Bun (it uses
 * `bun:sqlite` and other `Bun.*` APIs), so it cannot run under Node — under Node
 * the import of `bun:sqlite` fails with an opaque `ERR_UNSUPPORTED_ESM_URL_SCHEME`
 * before any of our code runs. `engines.bun` is advisory under npm (npm does not
 * enforce it), and npm is the main discovery path, so a Node user would otherwise
 * fail silently.
 *
 * This module detects the runtime at CLI startup (src/index.ts) and turns that
 * opaque failure into a human-readable message + `exit 1` (no stack trace). The
 * core predicate (`checkBunRuntime`) is a pure function over an injected version
 * string so it can be unit-tested on CI (which always runs on Bun).
 *
 * The same minimum (`MIN_BUN_VERSION`) is mirrored by `engines.bun` in
 * package.json and by the npm-install `postinstall` warning (scripts/postinstall.mjs).
 */

/** Minimum supported Bun major.minor (mirrors `engines.bun` ">=1.1"). */
export const MIN_BUN_VERSION = "1.1";

/** Result of a runtime check: `ok` when Bun is present and recent enough. */
export interface RuntimeCheck {
  ok: boolean;
  /** Human-readable, multi-line guidance. Only set when `ok` is false. */
  message?: string;
}

/**
 * Parse the leading `major.minor` of a version string into a comparable tuple.
 * Tolerates pre-release / build suffixes (e.g. "1.1.30-canary" → [1, 1]).
 * Returns `null` when the string has no recognisable `major.minor` prefix.
 */
function parseMajorMinor(version: string): [number, number] | null {
  const match = /^\s*v?(\d+)\.(\d+)/.exec(version);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2])];
}

/** True when `version` is >= `minimum` comparing `major.minor` only. */
export function bunVersionAtLeast(version: string, minimum: string): boolean {
  const got = parseMajorMinor(version);
  const min = parseMajorMinor(minimum);
  if (got === null || min === null) return false;
  if (got[0] !== min[0]) return got[0] > min[0];
  return got[1] >= min[1];
}

/** Shared install guidance appended to every failure message. */
const GUIDANCE = [
  "Suasor runs on Bun (it uses bun:sqlite and other Bun.* APIs) and cannot run under Node.",
  "",
  "Fix one of:",
  "  - Install Bun and re-run with `bunx`:  curl -fsSL https://bun.sh/install | bash",
  "    then:  bunx @ozzylabs/suasor mcp serve   (use bunx, NOT npx)",
  "  - Use the standalone binary (Bun bundled, no runtime needed):",
  "    https://github.com/ozzy-labs/suasor/releases",
  "  - Use the Docker image:  docker run --rm -i ghcr.io/ozzy-labs/suasor:latest",
  "",
  "See https://github.com/ozzy-labs/suasor/blob/main/docs/guide/install.md",
].join("\n");

/**
 * Decide whether the current runtime can run Suasor.
 *
 * @param bunVersion the value of `Bun.version` (or `undefined` when not running
 *   on Bun, e.g. under Node where the global `Bun` is absent).
 * @param minimum minimum acceptable `major.minor` (defaults to {@link MIN_BUN_VERSION}).
 */
export function checkBunRuntime(
  bunVersion: string | undefined,
  minimum: string = MIN_BUN_VERSION,
): RuntimeCheck {
  if (bunVersion === undefined || bunVersion === "") {
    return {
      ok: false,
      message: `Suasor requires the Bun runtime, but it is not running under Bun.\n\n${GUIDANCE}`,
    };
  }
  if (!bunVersionAtLeast(bunVersion, minimum)) {
    return {
      ok: false,
      message:
        `Suasor requires Bun >= ${minimum}, but found Bun ${bunVersion}.\n\n` +
        "Upgrade Bun:  bun upgrade\n\n" +
        GUIDANCE,
    };
  }
  return { ok: true };
}

/**
 * Read the running Bun version, or `undefined` when not on Bun. Isolated so the
 * `Bun` global access (which TypeScript/Node typings may not know about) is in
 * one place and the rest stays pure/testable.
 */
export function currentBunVersion(): string | undefined {
  const g = globalThis as { Bun?: { version?: string } };
  return g.Bun?.version;
}
