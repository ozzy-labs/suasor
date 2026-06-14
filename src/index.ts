#!/usr/bin/env bun
/**
 * Suasor entry point.
 *
 * Scaffold only. The CLI (clipanion) and MCP server (TS SDK) are wired during
 * implementation per the spec-driven plan — see docs/design/cli.md and
 * docs/design/mcp-surface.md. Architecture invariants live in docs/adr/.
 */
export const VERSION = "0.0.0";

async function main(): Promise<void> {
  // TODO(impl): wire CLI (src/cli) + MCP server (src/mcp). See docs/design/.
  console.log("suasor: scaffold. See docs/ for the spec-driven plan.");
}

if (import.meta.main) {
  await main();
}
