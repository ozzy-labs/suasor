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

  test("warns (stderr, exit 0) when repos empty and notifications=off (#187)", async () => {
    await run(["init"]);
    // Enabled but no ingest target: no repos and notifications off. The run still
    // succeeds (0 observed) but a pre-sync warning surfaces the no-op config.
    await writeConfig("[connectors.github]\nrepos = []\n");
    const { code, out, err } = await run(["github", "sync"]);
    expect(code).toBe(0);
    expect(out).toContain("0 observed");
    expect(err).toContain("warning: github:");
    expect(err).toContain("notifications=off");
  });

  test("--discover and --no-discover together fail fast with exit 1 (ADR-0039)", async () => {
    await run(["init"]);
    await writeConfig("[connectors.github]\nrepos = []\n");
    const { code, err } = await run(["github", "sync", "--discover", "--no-discover"]);
    expect(code).toBe(1);
    expect(err).toContain("--discover and --no-discover cannot be combined");
  });

  test("--discover on a non-discovery connector is a harmless no-op (no regression)", async () => {
    await run(["init"]);
    await writeConfig("[connectors.github]\nrepos = []\n");
    // github has no discovery concept; the override flag is accepted and ignored.
    const { code, out } = await run(["github", "sync", "--discover"]);
    expect(code).toBe(0);
    expect(out).toContain("0 observed");
  });

  test("--no-discover on a non-discovery connector is a harmless no-op (no regression)", async () => {
    await run(["init"]);
    await writeConfig("[connectors.github]\nrepos = []\n");
    const { code, out } = await run(["github", "sync", "--no-discover"]);
    expect(code).toBe(0);
    expect(out).toContain("0 observed");
  });

  test("does NOT warn when notifications stream is enabled (#187)", async () => {
    await run(["init"]);
    // repos empty but notifications=all → the per-token notification stream is a
    // valid ingest target, so no no-op warning. (The sync itself then fails on the
    // missing token, but the no-op advisory must not fire — that is what we assert.)
    await writeConfig('[connectors.github]\nrepos = []\nnotifications = "all"\n');
    const { err } = await run(["github", "sync"]);
    expect(err).not.toContain("取り込み対象なし");
  });
});
