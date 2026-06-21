#!/usr/bin/env node
/**
 * npm `postinstall` hook for `@ozzylabs/suasor`.
 *
 * Suasor runs on the Bun runtime (it uses `bun:sqlite` and other `Bun.*` APIs),
 * but `engines.bun` is only advisory under npm — npm does not enforce it, so a
 * `npm install` succeeds even with no Bun on the host and the failure only
 * surfaces later at runtime with an opaque `ERR_UNSUPPORTED_ESM_URL_SCHEME`.
 * Since npm is the main discovery path, this hook surfaces the requirement at
 * install time.
 *
 * Contract (Issue #155):
 *   - WARN only — never fail the install (always exits 0). A missing Bun must not
 *     break `npm install` (e.g. transitive installs, CI that fetches but runs via
 *     bunx, the Docker/binary channels that vendor Bun).
 *   - No dev dependencies — this ships in the published tarball (see package.json
 *     `files`) and must run with nothing but Node's standard library.
 *   - Runs under whatever runtime invoked the install (Node for `npm`, Bun for
 *     `bun add`). Both are handled.
 */

import { spawnSync } from "node:child_process";

// Mirror of `engines.bun` / src/runtime-guard.ts MIN_BUN_VERSION.
const MIN_BUN_VERSION = "1.2";

/**
 * Detect a usable Bun: either we are already running under Bun, or a `bun`
 * binary is reachable on PATH. Returns the version string when found, else null.
 */
function detectBunVersion() {
  // Running under Bun (e.g. `bun add @ozzylabs/suasor`): version is on
  // process.versions.bun.
  const underBun = process.versions?.bun;
  if (typeof underBun === "string" && underBun.length > 0) return underBun;

  // Running under Node (the `npm install` case): probe PATH for `bun`.
  try {
    const res = spawnSync("bun", ["--version"], { encoding: "utf8", timeout: 10_000 });
    if (res.status === 0 && typeof res.stdout === "string") {
      const v = res.stdout.trim();
      if (v.length > 0) return v;
    }
  } catch {
    // ENOENT etc. — treated as "no Bun".
  }
  return null;
}

const WARN = [
  "",
  "  ┌─────────────────────────────────────────────────────────────────────────┐",
  "  │  @ozzylabs/suasor: Bun runtime not detected.                              │",
  "  │                                                                           │",
  `  │  Suasor runs on Bun >= ${MIN_BUN_VERSION} (it uses bun:sqlite and other Bun.* APIs) and  │`,
  "  │  cannot run under Node — `npx`/`node` will fail at runtime.                │",
  "  │                                                                           │",
  "  │  This install did NOT fail; install one of these to actually run Suasor:  │",
  "  │    • Bun:     curl -fsSL https://bun.sh/install | bash                     │",
  "  │              then run with  bunx @ozzylabs/suasor mcp serve  (not npx)     │",
  "  │    • Binary:  https://github.com/ozzy-labs/suasor/releases  (Bun bundled)  │",
  "  │    • Docker:  ghcr.io/ozzy-labs/suasor:latest               (Bun bundled)  │",
  "  │                                                                           │",
  "  │  Docs: https://github.com/ozzy-labs/suasor/blob/main/docs/guide/install.md │",
  "  └─────────────────────────────────────────────────────────────────────────┘",
  "",
].join("\n");

function main() {
  // Allow CI / reproducible builds to silence the advisory.
  if (process.env.SUASOR_SKIP_POSTINSTALL === "1") return;

  const bunVersion = detectBunVersion();
  if (bunVersion === null) {
    // WARN only — never fail the install.
    process.stderr.write(`${WARN}\n`);
  }
  // When Bun is present we stay silent (no success noise on a normal install).
}

main();
