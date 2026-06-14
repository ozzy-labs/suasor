#!/usr/bin/env bun
/**
 * Suasor entry point.
 *
 * Dispatches to the clipanion CLI (src/cli). Heavy dependencies are lazy-loaded
 * inside each command to keep cold start light (NFR-PRF-1). Architecture
 * invariants live in docs/adr/; surfaces are specified in docs/design/.
 */
export { VERSION } from "./version.ts";

async function main(): Promise<void> {
  const { runCli } = await import("./cli/index.ts");
  process.exitCode = await runCli();
}

if (import.meta.main) {
  await main();
}
