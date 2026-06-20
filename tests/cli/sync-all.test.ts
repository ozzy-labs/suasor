/**
 * `suasor sync` CLI wiring (ADR-0027, FR-ING-5/6, docs/design/cli.md).
 *
 * Exercises the bulk-sync command end-to-end against a real on-disk store. To
 * stay network-free, enabled connectors use the `github` connector with
 * `repos = []` (yields no records, builds no Octokit client) and the auth-free
 * `web` connector with no pages, so the full CLI → config → registry →
 * bulk-sync → sync-service path runs without touching the network.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCli } from "../../src/cli/index.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "suasor-cli-sync-all-"));
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

async function writeConfig(toml: string): Promise<void> {
  await Bun.write(join(dir, "config.toml"), toml);
}

describe("suasor sync (bulk)", () => {
  test("--help lists the bulk sync command", async () => {
    const { code, out } = await run(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("Ingest from every enabled connector");
  });

  test("no enabled connectors reports a friendly message and exits 0", async () => {
    await run(["init"]);
    await writeConfig("");
    const { code, out } = await run(["sync"]);
    expect(code).toBe(0);
    expect(out).toContain("no connectors enabled");
  });

  test("runs all enabled connectors and reports per-connector counts", async () => {
    await run(["init"]);
    await writeConfig("[connectors.github]\nrepos = []\n[connectors.web]\nurls = []\n");
    const { code, out } = await run(["sync"]);
    expect(code).toBe(0);
    expect(out).toContain("github: 0 observed");
    expect(out).toContain("web: 0 observed");
    expect(out).toContain("2 succeeded, 0 failed");
  });

  test("--connector narrows to the named enabled connectors", async () => {
    await run(["init"]);
    await writeConfig("[connectors.github]\nrepos = []\n[connectors.web]\nurls = []\n");
    const { code, out } = await run(["sync", "--connector", "web"]);
    expect(code).toBe(0);
    expect(out).toContain("web: 0 observed");
    expect(out).not.toContain("github:");
    expect(out).toContain("1 succeeded");
  });

  test("--connector with a non-enabled name fails fast with exit 1", async () => {
    await run(["init"]);
    await writeConfig("[connectors.web]\nurls = []\n");
    const { code, err } = await run(["sync", "--connector", "github"]);
    expect(code).toBe(1);
    expect(err).toContain("not enabled or not registered");
  });

  test("--json emits the aggregate result", async () => {
    await run(["init"]);
    await writeConfig("[connectors.web]\nurls = []\n");
    const { code, out } = await run(["sync", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as {
      succeeded: number;
      failed: number;
      results: { connector: string; ok: boolean }[];
    };
    expect(parsed.succeeded).toBe(1);
    expect(parsed.failed).toBe(0);
    expect(parsed.results[0]?.connector).toBe("web");
    expect(parsed.results[0]?.ok).toBe(true);
  });

  test("continue-on-error: one connector failing exits 1 but others still run", async () => {
    await run(["init"]);
    // github with an invalid repo spec throws at load; web still ingests fine.
    await writeConfig('[connectors.github]\nrepos = ["not-a-repo"]\n[connectors.web]\nurls = []\n');
    const { code, out, err } = await run(["sync"]);
    expect(code).toBe(1);
    expect(err).toContain("github sync failed");
    expect(out).toContain("web: 0 observed");
    expect(out).toContain("1 succeeded, 1 failed");
  });
});
