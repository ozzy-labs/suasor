import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCli } from "../../src/cli/index.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "suasor-cli-emb-"));
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

/** Seed a source into the same db the CLI will open. */
async function seed(externalId: string, body: string) {
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

describe("suasor embeddings status (backend disabled by default)", () => {
  test("reports disabled backend and counts sources as pending", async () => {
    await seed("gh:1", "alpha");
    const { code, out } = await run(["embeddings", "status"]);
    expect(code).toBe(0);
    expect(out).toContain("backend: disabled");
    expect(out).toContain("github_issue: 0/1 embedded, 1 pending");
    expect(out).toContain("nothing to do");
  });

  test("--json emits a machine-readable snapshot", async () => {
    await seed("gh:1", "alpha");
    const { code, out } = await run(["embeddings", "status", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.backend).toBe("disabled");
    expect(parsed.auto).toBe(false);
    expect(parsed.totals).toEqual({ total: 1, embedded: 0, pending: 1, stale: 0 });
  });
});

describe("suasor embeddings rebuild/drain/find-duplicates (disabled no-op)", () => {
  test("rebuild is a no-op with an explicit message", async () => {
    await seed("gh:1", "alpha");
    const { code, out } = await run(["embeddings", "rebuild"]);
    expect(code).toBe(0);
    expect(out).toContain("nothing to do");
  });

  test("drain is a no-op with an explicit message", async () => {
    await seed("gh:1", "alpha");
    const { code, out } = await run(["embeddings", "drain"]);
    expect(code).toBe(0);
    expect(out).toContain("nothing to do");
  });

  test("rebuild/drain accept --no-progress", async () => {
    await seed("gh:1", "alpha");
    const rebuild = await run(["embeddings", "rebuild", "--no-progress"]);
    expect(rebuild.code).toBe(0);
    expect(rebuild.out).toContain("nothing to do");
    const drain = await run(["embeddings", "drain", "--no-progress"]);
    expect(drain.code).toBe(0);
    expect(drain.out).toContain("nothing to do");
  });

  test("find-duplicates is a no-op with an explicit message", async () => {
    await seed("gh:1", "alpha");
    const { code, out } = await run(["embeddings", "find-duplicates"]);
    expect(code).toBe(0);
    expect(out).toContain("nothing to do");
  });

  test("disabled gate short-circuits before --threshold validation (no-op)", async () => {
    // The disabled-backend gate wins over threshold parsing, so even a bad
    // --threshold yields the no-op message rather than a validation error.
    const { code, out } = await run(["embeddings", "find-duplicates", "--threshold", "2"]);
    expect(code).toBe(0);
    expect(out).toContain("nothing to do");
  });

  test("find-duplicates accepts --no-progress", async () => {
    await seed("gh:1", "alpha");
    const { code, out } = await run(["embeddings", "find-duplicates", "--no-progress"]);
    expect(code).toBe(0);
    expect(out).toContain("nothing to do");
  });
});

describe("suasor embeddings list-failed (Issue #202)", () => {
  test("lists every source as pending when the backend is disabled", async () => {
    await seed("gh:1", "alpha");
    await seed("gh:2", "beta");
    const { code, out } = await run(["embeddings", "list-failed"]);
    expect(code).toBe(0);
    expect(out).toContain("2 source(s) missing a current-model vector");
    expect(out).toContain("[pending] github_issue  gh:1");
    expect(out).toContain("nothing to do"); // disabled-backend note
  });

  test("--json emits the failed-source list", async () => {
    await seed("gh:1", "alpha");
    const { code, out } = await run(["embeddings", "list-failed", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed).toEqual([{ externalId: "gh:1", sourceType: "github_issue", reason: "pending" }]);
  });

  test("--limit caps the listing", async () => {
    await seed("gh:1", "alpha");
    await seed("gh:2", "beta");
    const { code, out } = await run(["embeddings", "list-failed", "--limit", "1", "--json"]);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toHaveLength(1);
  });

  test("rejects a non-positive --limit", async () => {
    const { code, err } = await run(["embeddings", "list-failed", "--limit", "0"]);
    expect(code).toBe(1);
    expect(err).toContain("--limit must be a positive integer");
  });

  test("a settled (empty) store reports nothing missing", async () => {
    const { code, out } = await run(["embeddings", "list-failed"]);
    expect(code).toBe(0);
    expect(out).toContain("No sources missing a current-model vector.");
  });
});
