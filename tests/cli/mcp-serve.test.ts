/**
 * `suasor mcp serve` CLI wiring (stdio MCP boot, ADR-0004 / docs/design/cli.md).
 *
 * The boot glue itself (`serveMcp`) is unit-tested with faked seams in
 * tests/mcp/serve.test.ts; here we cover the thin clipanion command wrapper:
 * registration, and the error lifecycle (a failed boot is caught, reported on
 * the diagnostics channel — never stdout, which is the JSON-RPC stream — and
 * mapped to exit 1). The success path is not driven here because it would
 * connect a real blocking stdio transport (Issue #268).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCli } from "../../src/cli/index.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "suasor-cli-mcp-serve-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const prev = process.env.SUASOR_CONFIG_DIR;
  process.env.SUASOR_CONFIG_DIR = dir;
  let out = "";
  let err = "";
  const cli = buildCli();
  try {
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
  } finally {
    if (prev === undefined) delete process.env.SUASOR_CONFIG_DIR;
    else process.env.SUASOR_CONFIG_DIR = prev;
  }
}

describe("suasor mcp serve", () => {
  test("--help lists the mcp serve command", async () => {
    const { code, out } = await run(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("mcp serve");
  });

  test("a boot failure is caught, reported on stderr, and exits 1 (stdout stays clean)", async () => {
    // Point storage at a path whose parent directory does not exist, so opening
    // the store throws inside serveMcp. The command must catch it, write the
    // diagnostic to stderr (never stdout — that's the JSON-RPC framing), and
    // return exit 1 rather than crashing.
    const badDbPath = join(dir, "missing-subdir", "suasor.db");
    await Bun.write(join(dir, "config.toml"), `[storage]\ndbPath = "${badDbPath}"\n`);

    const { code, out, err } = await run(["mcp", "serve"]);
    expect(code).toBe(1);
    // Diagnostics are on stderr, prefixed by the command; stdout is untouched so
    // a host parsing stdout never sees a non-JSON-RPC line.
    expect(err).toContain("suasor mcp serve:");
    expect(out).toBe("");
  });
});
