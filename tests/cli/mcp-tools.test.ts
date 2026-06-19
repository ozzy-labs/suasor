/**
 * `suasor mcp tools` CLI wiring (introspection verb, ADR-0004 /
 * docs/design/mcp-surface.md). Lists the MCP tool surface offline (no server,
 * no Store). The drift between this catalog and an actually-registered server is
 * guarded by tests/mcp/tool-catalog.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { buildCli } from "../../src/cli/index.ts";

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const cli = buildCli();
  const code = await cli.run(args, {
    stdin: process.stdin,
    stdout: {
      write: (s: string) => {
        out += s;
        return true;
      },
    } as NodeJS.WriteStream,
    stderr: {
      write: (s: string) => {
        err += s;
        return true;
      },
    } as NodeJS.WriteStream,
    env: process.env,
    colorDepth: 1,
  });
  return { code, out, err };
}

type Tool = { name: string; readOnlyHint: boolean; summary: string };

describe("suasor mcp tools", () => {
  test("--help lists the mcp tools command", async () => {
    const { code, out } = await run(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("mcp tools");
  });

  test("--json emits the tool catalog with read/write classification", async () => {
    const { code, out } = await run(["mcp", "tools", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as Tool[];
    const names = parsed.map((t) => t.name);
    // A representative read tool and a write tool are both present.
    expect(names).toContain("search");
    expect(names).toContain("connector.sync");
    expect(parsed.find((t) => t.name === "search")?.readOnlyHint).toBe(true);
    expect(parsed.find((t) => t.name === "connector.sync")?.readOnlyHint).toBe(false);
  });

  test("human-readable output shows a read/write count line", async () => {
    const { code, out } = await run(["mcp", "tools"]);
    expect(code).toBe(0);
    expect(out).toContain("search");
    expect(out).toMatch(/\d+ tool\(s\): \d+ read, \d+ write \(HITL\)\./);
  });
});
