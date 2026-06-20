import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCli } from "../../src/cli/index.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "suasor-cli-search-"));
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

/** Seed the db the CLI will open (default path under SUASOR_CONFIG_DIR). */
async function seed(body: string, externalId = "gh:1"): Promise<void> {
  const { Store } = await import("../../src/db/index.ts");
  const store = Store.open({ path: join(dir, "suasor.db") });
  store.record({
    type: "SourceObserved",
    externalId,
    sourceType: "github_issue",
    body,
    observedAt: "2026-06-14T00:00:00.000Z",
    fingerprint: externalId,
    meta: {},
  });
  store.close();
}

describe("suasor search", () => {
  test("prints ranked hits for a matching query", async () => {
    await seed("deploy the rocket to mars");
    const { code, out } = await run(["search", "rocket"]);
    expect(code).toBe(0);
    expect(out).toContain("1 result(s) [fts]");
    expect(out).toContain("gh:1");
  });

  test("prints 'No results.' when nothing matches", async () => {
    await seed("deploy the rocket");
    const { code, out } = await run(["search", "submarine"]);
    expect(code).toBe(0);
    expect(out).toContain("No results.");
  });

  test("--json emits machine-readable output with the strategy", async () => {
    await seed("deploy the rocket");
    const { code, out } = await run(["search", "--json", "rocket"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.strategy).toBe("fts");
    expect(parsed.hits[0].externalId).toBe("gh:1");
  });

  test("rejects a non-positive --limit", async () => {
    await seed("deploy the rocket");
    const { code, err } = await run(["search", "--limit", "0", "rocket"]);
    expect(code).toBe(1);
    expect(err).toContain("--limit must be a positive integer");
  });

  test("a short query uses the LIKE fallback strategy", async () => {
    await seed("go to the store");
    const { code, out } = await run(["search", "--json", "go"]);
    expect(code).toBe(0);
    expect(JSON.parse(out).strategy).toBe("like-fallback");
  });

  test("hints on stderr when the embedding backend is disabled (Issue #159)", async () => {
    await seed("deploy the rocket");
    const { code, out, err } = await run(["search", "rocket"]);
    expect(code).toBe(0);
    expect(err).toContain("embedding disabled");
    expect(err).toContain("docs/guide/embedding.md");
    // stdout (the result body) must stay clean of the hint.
    expect(out).not.toContain("embedding disabled");
  });

  test("emits no hint when the embedding backend is enabled (Issue #159)", async () => {
    await Bun.write(join(dir, "config.toml"), '[embedding]\nbackend = "ollama"\n');
    await seed("deploy the rocket");
    const { code, err } = await run(["search", "rocket"]);
    expect(code).toBe(0);
    expect(err).not.toContain("embedding disabled");
  });

  test("--json suppresses the hint so stdout/stderr stay pipe-clean (Issue #159)", async () => {
    await seed("deploy the rocket");
    const { code, out, err } = await run(["search", "--json", "rocket"]);
    expect(code).toBe(0);
    expect(err).not.toContain("embedding disabled");
    expect(out).not.toContain("embedding disabled");
    // stdout still parses as the result JSON.
    expect(JSON.parse(out).strategy).toBe("fts");
  });
});
