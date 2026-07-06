/**
 * README MCP tool-list drift guard (issue #446).
 *
 * `README.md` / `README.ja.md` embed a generated tool list between HTML markers.
 * This test pins each README's embedded block to the freshly-rendered catalog so
 * the docs can never silently drift from the real MCP surface again — the exact
 * failure #446 fixed, where the hand-listed set claimed 4 write tools and never
 * mentioned the ADR-0036 actuators that egress to GitHub / Jira / Slack.
 *
 * When this fails, run `bun run gen:readme-tools` to regenerate both READMEs.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mcpToolCatalog } from "../../src/mcp/tool-catalog.ts";
import {
  MCP_TOOLS_BEGIN_PREFIX,
  MCP_TOOLS_END,
  renderMcpToolsBlock,
} from "../../src/mcp/tool-catalog-doc.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const README_FILES = ["README.md", "README.ja.md"] as const;

/** Extract the generated span (opening prefix … closing marker, inclusive). */
function extractBlock(source: string): string {
  const begin = source.indexOf(MCP_TOOLS_BEGIN_PREFIX);
  const endMarker = source.indexOf(MCP_TOOLS_END);
  expect(begin).toBeGreaterThanOrEqual(0);
  expect(endMarker).toBeGreaterThan(begin);
  return source.slice(begin, endMarker + MCP_TOOLS_END.length);
}

describe("README MCP tool list ↔ tool-catalog", () => {
  const block = renderMcpToolsBlock();

  for (const file of README_FILES) {
    test(`${file} embeds the up-to-date generated tool list`, () => {
      const source = readFileSync(join(repoRoot, file), "utf8");
      // Stale? run `bun run gen:readme-tools`.
      expect(extractBlock(source)).toBe(block);
    });
  }

  test("the generated block lists every catalog tool", () => {
    for (const tool of mcpToolCatalog(true)) {
      expect(block).toContain(`\`${tool.name}\``);
    }
  });

  test("the block surfaces the actuators the old README omitted", () => {
    for (const name of ["task.publish", "task.act", "task.update", "source.forget"]) {
      expect(block).toContain(`\`${name}\``);
    }
  });

  test("write tools are labelled HITL with no auto-apply path", () => {
    expect(block).toContain("no auto-apply");
    expect(block).toContain("actuators");
  });
});
