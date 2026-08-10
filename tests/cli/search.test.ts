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
async function seed(
  body: string,
  externalId = "gh:1",
  observedAt = "2026-06-14T00:00:00.000Z",
): Promise<void> {
  const { Store } = await import("../../src/db/index.ts");
  const store = Store.open({ path: join(dir, "suasor.db") });
  store.record({
    type: "SourceObserved",
    externalId,
    sourceType: "github_issue",
    body,
    observedAt,
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

  test("annotates the strategy when nothing matches", async () => {
    await seed("deploy the rocket");
    const { code, out } = await run(["search", "submarine"]);
    expect(code).toBe(0);
    expect(out).toContain("No results [fts].");
  });

  test("--json emits machine-readable output with the strategy", async () => {
    await seed("deploy the rocket");
    const { code, out } = await run(["search", "--json", "rocket"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.strategy).toBe("fts");
    expect(parsed.hits[0].externalId).toBe("gh:1");
  });

  test("--json includes totalHits / truncated / analyzedQuery", async () => {
    await seed("deploy the rocket");
    const { code, out } = await run(["search", "--json", "deploy rocket"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.totalHits).toBe(1);
    expect(parsed.truncated).toBe(false);
    expect(parsed.analyzedQuery).toEqual(["deploy", "rocket"]);
  });

  test("human output shows totalHits when --limit truncates the result set", async () => {
    for (let i = 0; i < 3; i++) await seed(`rocket number ${i}`, `gh:${i}`);
    const { code, out } = await run(["search", "--limit", "1", "rocket"]);
    expect(code).toBe(0);
    expect(out).toContain("1 of 3 result(s) [fts]:");
  });

  test("--source-type filters the result set", async () => {
    await seed("deploy the rocket", "gh:1");
    const { code, out } = await run([
      "search",
      "--json",
      "--source-type",
      "slack_message",
      "rocket",
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(out).hits).toHaveLength(0); // seeded source is github_issue
  });

  test("--observed-after / --observed-before window filters the result set", async () => {
    await seed("deploy the rocket", "gh:1"); // observedAt 2026-06-14T00:00:00.000Z
    const { code, out } = await run([
      "search",
      "--json",
      "--observed-after",
      "2026-06-15T00:00:00.000Z",
      "rocket",
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(out).hits).toHaveLength(0); // the seeded row is before the lower bound
  });

  test("--since / --until are the canonical names for the observed window", async () => {
    await seed("deploy the rocket", "gh:1"); // observedAt 2026-06-14T00:00:00.000Z
    const { code, out } = await run([
      "search",
      "--json",
      "--since",
      "2026-06-15T00:00:00.000Z",
      "rocket",
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(out).hits).toHaveLength(0); // the seeded row is before the lower bound
  });

  test("--since accepts a relative duration (7d)", async () => {
    await seed("old rocket", "gh:old", "2020-01-01T00:00:00.000Z");
    await seed("recent rocket", "gh:recent", new Date(Date.now() - 3_600_000).toISOString());
    const { code, out } = await run(["search", "--json", "--since", "7d", "rocket"]);
    expect(code).toBe(0);
    const hits = JSON.parse(out).hits;
    expect(hits).toHaveLength(1); // only the row inside the window
    expect(hits[0].externalId).toBe("gh:recent");
  });

  test("rejects an unparseable --since instead of silently matching nothing (#561)", async () => {
    await seed("deploy the rocket");
    const { code, err } = await run(["search", "--since", "banana", "rocket"]);
    expect(code).toBe(1);
    expect(err).toContain("--since must be a duration (24h / 7d / 2w) or ISO date");
  });

  test("rejects an unparseable --until", async () => {
    await seed("deploy the rocket");
    const { code, err } = await run(["search", "--until", "2026-13-99", "rocket"]);
    expect(code).toBe(1);
    expect(err).toContain("--until must be a duration (24h / 7d / 2w) or ISO date");
  });

  test("help documents the filters and the literal-operator note", async () => {
    const { out } = await run(["search", "--help"]);
    expect(out).toContain("--source-type");
    expect(out).toContain("--since");
    expect(out).toContain("--until");
    expect(out).toContain("--observed-after");
    expect(out).toContain("--observed-before");
    expect(out).toContain("literal");
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

  test("--json returns a bounded excerpt (not the full body) by default (retrieval-m2)", async () => {
    await seed("deploy the rocket");
    const { code, out } = await run(["search", "--json", "rocket"]);
    expect(code).toBe(0);
    const hit = JSON.parse(out).hits[0];
    expect(hit.body).toBeUndefined();
    expect(hit.excerpt).toBeDefined();
  });

  test("--full-body includes the full body per hit (retrieval-m2)", async () => {
    await seed("deploy the rocket");
    const { code, out } = await run(["search", "--json", "--full-body", "rocket"]);
    expect(code).toBe(0);
    const hit = JSON.parse(out).hits[0];
    expect(hit.excerpt).toBeUndefined();
    expect(hit.body).toBe("deploy the rocket");
  });

  test("rejects a non-positive --max-body-chars", async () => {
    await seed("deploy the rocket");
    const { code, err } = await run(["search", "--max-body-chars", "0", "rocket"]);
    expect(code).toBe(1);
    expect(err).toContain("--max-body-chars must be a positive integer");
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
