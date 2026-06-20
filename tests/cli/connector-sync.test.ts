/**
 * `suasor <connector> sync` CLI wiring (FR-ING-4, docs/design/cli.md).
 *
 * Exercises the registered `github sync` command end-to-end against a real
 * on-disk store. To stay network-free, the config sets `repos = []`, so the
 * GitHub connector yields no records (and never builds an Octokit client) while
 * the full CLI → config → registry → sync-service path still runs.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCli } from "../../src/cli/index.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "suasor-cli-sync-"));
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

describe("suasor github sync", () => {
  test("--help lists the github sync command", async () => {
    const { code, out } = await run(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("github sync");
  });

  test("runs end-to-end with no repos (no network) and reports counts", async () => {
    await run(["init"]);
    await writeConfig("[connectors.github]\nrepos = []\n");
    const { code, out } = await run(["github", "sync"]);
    expect(code).toBe(0);
    expect(out).toContain("0 observed");
  });

  test("--json emits the sync outcome", async () => {
    await run(["init"]);
    await writeConfig("[connectors.github]\nrepos = []\n");
    const { code, out } = await run(["github", "sync", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as { connector: string; observed: number };
    expect(parsed.connector).toBe("github");
    expect(parsed.observed).toBe(0);
  });

  test("invalid connector config fails fast with exit 1 (load-time slice validation, #162)", async () => {
    await run(["init"]);
    // A malformed `owner/repo` entry is rejected by the github slice schema at
    // load (`loadConfig`), before the connector is built — fail-fast (#162).
    await writeConfig('[connectors.github]\nrepos = ["not-a-repo"]\n');
    const { code, err } = await run(["github", "sync"]);
    expect(code).toBe(1);
    expect(err).toContain("error:");
    expect(err).toContain("connectors.github.repos");
  });

  test("a typo'd connector key fails fast with exit 1 (#162)", async () => {
    await run(["init"]);
    // `repo` for `repos` — the exact silent-no-op typo #162 targets.
    await writeConfig('[connectors.github]\nrepo = ["owner/repo"]\n');
    const { code, err } = await run(["github", "sync"]);
    expect(code).toBe(1);
    expect(err).toContain("error:");
    expect(err).toContain("connectors.github");
  });
});
