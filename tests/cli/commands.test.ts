import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCli } from "../../src/cli/index.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "suasor-cli-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Run the CLI capturing stdout/stderr; uses SUASOR_CONFIG_DIR for isolation. */
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

describe("suasor --version / --help", () => {
  test("--version prints the package version", async () => {
    const { VERSION } = await import("../../src/version.ts");
    const { code, out } = await run(["--version"]);
    expect(code).toBe(0);
    expect(out.trim()).toBe(VERSION);
  });

  test("--help lists the wired command surface", async () => {
    const { code, out } = await run(["--help"]);
    expect(code).toBe(0);
    for (const cmd of ["init", "db migrate", "projections rebuild", "search", "mcp serve"]) {
      expect(out).toContain(cmd);
    }
  });
});

describe("suasor init", () => {
  test("creates config + db and is idempotent", async () => {
    const first = await run(["init"]);
    expect(first.code).toBe(0);
    expect(first.out).toContain("Wrote default config");
    expect(first.out).toContain("Initialized database");
    expect(existsSync(join(dir, "config.toml"))).toBe(true);
    expect(existsSync(join(dir, "suasor.db"))).toBe(true);

    // Re-run: config is preserved, not overwritten.
    const second = await run(["init"]);
    expect(second.code).toBe(0);
    expect(second.out).toContain("Config already exists");
  });

  test("--force overwrites the existing config", async () => {
    await run(["init"]);
    const forced = await run(["init", "--force"]);
    expect(forced.code).toBe(0);
    expect(forced.out).toContain("Overwrote default config");
  });
});

describe("suasor db migrate", () => {
  test("applies the projection schema (idempotent)", async () => {
    const first = await run(["db", "migrate"]);
    expect(first.code).toBe(0);
    expect(first.out).toContain("Applied projection schema");
    expect(existsSync(join(dir, "suasor.db"))).toBe(true);

    const second = await run(["db", "migrate"]);
    expect(second.code).toBe(0);
  });
});

describe("suasor search", () => {
  /** Seed the db the CLI will open with one source body. */
  async function seed(externalId: string, body: string): Promise<void> {
    const { Store } = await import("../../src/db/index.ts");
    const store = Store.open({ path: join(dir, "suasor.db") });
    store.record({
      type: "SourceObserved",
      externalId,
      sourceType: "github_issue",
      body,
      observedAt: "2026-06-14T00:00:00.000Z",
      fingerprint: "fp1",
      meta: {},
    });
    store.close();
  }

  test("prints matching sources", async () => {
    await seed("gh:1", "the release pipeline runbook");
    const { code, out } = await run(["search", "release"]);
    expect(code).toBe(0);
    expect(out).toContain("gh:1");
    expect(out).toContain("github_issue");
  });

  test("reports no matches cleanly", async () => {
    await seed("gh:1", "nothing relevant here");
    const { code, out } = await run(["search", "release"]);
    expect(code).toBe(0);
    expect(out).toContain("No matches.");
  });

  test("--json emits a JSON array", async () => {
    await seed("gh:1", "the release pipeline runbook");
    const { code, out } = await run(["search", "--json", "release"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].externalId).toBe("gh:1");
  });

  test("rejects an invalid --limit", async () => {
    await seed("gh:1", "the release pipeline runbook");
    const { code, err } = await run(["search", "--limit", "0", "release"]);
    expect(code).toBe(1);
    expect(err).toContain("--limit must be a positive integer");
  });
});

describe("downstream stubs", () => {
  test("mcp serve exits 0 with a pending notice", async () => {
    const { code, err } = await run(["mcp", "serve"]);
    expect(code).toBe(0);
    expect(err).toContain("not yet implemented");
  });

  test("skills install accepts --scope and reports pending", async () => {
    const { code, err } = await run(["skills", "install", "--scope", "claude"]);
    expect(code).toBe(0);
    expect(err).toContain("scope=claude");
  });

  test("skills install rejects an invalid --scope", async () => {
    const { code, err } = await run(["skills", "install", "--scope", "bogus"]);
    expect(code).toBe(1);
    expect(err).toContain("invalid --scope");
  });

  test("skills list exits 0 with a pending notice", async () => {
    const { code, err } = await run(["skills", "list"]);
    expect(code).toBe(0);
    expect(err).toContain("not yet implemented");
  });
});
