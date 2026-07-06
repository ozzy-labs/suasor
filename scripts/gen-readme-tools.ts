#!/usr/bin/env bun
/**
 * Regenerate the MCP tool list embedded in `README.md` / `README.ja.md` from the
 * single catalog (`src/mcp/tool-catalog.ts`), so the docs can never drift from
 * the real surface (issue #446 — the hand-listed set omitted the ADR-0036
 * actuators). Run after changing the catalog:
 *
 *   bun run gen:readme-tools           # rewrite the block in both READMEs
 *   bun run gen:readme-tools --check   # exit 1 if either README is stale (CI)
 *
 * The authoritative drift guard is `tests/mcp/tool-catalog-doc.test.ts` (runs in
 * `bun test`); `--check` is a convenience for scripting the same assertion.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MCP_TOOLS_BEGIN_PREFIX,
  MCP_TOOLS_END,
  renderMcpToolsBlock,
} from "../src/mcp/tool-catalog-doc.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const README_FILES = ["README.md", "README.ja.md"] as const;

/** Replace the marked span (opening prefix … closing marker, inclusive). */
function replaceBlock(source: string, block: string): string {
  const begin = source.indexOf(MCP_TOOLS_BEGIN_PREFIX);
  const endMarker = source.indexOf(MCP_TOOLS_END);
  if (begin === -1 || endMarker === -1 || endMarker < begin) {
    throw new Error(
      `mcp-tools markers not found (expected '${MCP_TOOLS_BEGIN_PREFIX}' … '${MCP_TOOLS_END}')`,
    );
  }
  return source.slice(0, begin) + block + source.slice(endMarker + MCP_TOOLS_END.length);
}

const check = process.argv.includes("--check");
const block = renderMcpToolsBlock();
let drift = false;

for (const file of README_FILES) {
  const path = join(repoRoot, file);
  const current = readFileSync(path, "utf8");
  const next = replaceBlock(current, block);
  if (current === next) continue;
  if (check) {
    drift = true;
    console.error(`drift: ${file} MCP tool list is stale`);
  } else {
    writeFileSync(path, next);
    console.log(`updated: ${file}`);
  }
}

if (check && drift) {
  console.error("Run `bun run gen:readme-tools` to regenerate.");
  process.exit(1);
}
