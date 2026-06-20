#!/usr/bin/env bun
/**
 * Suasor entry point.
 *
 * Dispatches to the clipanion CLI (src/cli). Heavy dependencies are lazy-loaded
 * inside each command to keep cold start light (NFR-PRF-1). Architecture
 * invariants live in docs/adr/; surfaces are specified in docs/design/.
 */
import { checkBunRuntime, currentBunVersion } from "./runtime-guard.ts";

export { VERSION } from "./version.ts";

async function main(): Promise<void> {
  const { runCli } = await import("./cli/index.ts");
  process.exitCode = await runCli();
}

if (import.meta.main) {
  // Fail fast with a human-readable message (no stack trace) when Bun is missing
  // or too old; otherwise the first `bun:sqlite` import throws an opaque
  // ERR_UNSUPPORTED_ESM_URL_SCHEME. engines.bun is advisory under npm, and npm is
  // the main discovery path, so this guard is the real enforcement point.
  const runtime = checkBunRuntime(currentBunVersion());
  if (!runtime.ok) {
    process.stderr.write(`${runtime.message}\n`);
    process.exit(1);
  }
  await main();
}
