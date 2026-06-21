/**
 * `suasor store info` CLI wiring (Issue #202). Runs end-to-end against a temp
 * config dir; asserts counts / file size / --json output and the not-migrated
 * error path.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCli } from "../../src/cli/index.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "suasor-cli-store-info-"));
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

describe("suasor store info", () => {
  test("--help lists the command", async () => {
    const { code, out } = await run(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("store info");
  });

  test("errors when the database does not exist", async () => {
    await run(["init"]); // writes config but with a default dbPath we then remove
    rmSync(join(dir, "suasor.db"), { force: true });
    rmSync(join(dir, "suasor.db-wal"), { force: true });
    rmSync(join(dir, "suasor.db-shm"), { force: true });
    const { code, err } = await run(["store", "info"]);
    expect(code).toBe(1);
    expect(err).toContain("database not found");
  });

  test("reports events / projection rows / file size", async () => {
    await run(["init"]);
    await seed("gh:1", "alpha");
    await seed("gh:2", "beta");
    const { code, out } = await run(["store", "info"]);
    expect(code).toBe(0);
    expect(out).toContain("events:");
    expect(out).toContain("sources");
    expect(out).toContain("file size:");
    expect(out).toContain("fts:");
  });

  test("--breakdown lists events grouped by type", async () => {
    await run(["init"]);
    await seed("gh:1", "alpha");
    await seed("gh:2", "beta");
    const { code, out } = await run(["store", "info", "--breakdown"]);
    expect(code).toBe(0);
    expect(out).toContain("events by type:");
    expect(out).toContain("SourceObserved");
  });

  test("--breakdown --json adds an eventBreakdown array", async () => {
    await run(["init"]);
    await seed("gh:1", "alpha");
    await seed("gh:2", "beta");
    const { code, out } = await run(["store", "info", "--breakdown", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    const observed = parsed.eventBreakdown.find(
      (e: { type: string }) => e.type === "SourceObserved",
    );
    expect(observed.count).toBe(2);
  });

  test("--json without --breakdown omits eventBreakdown", async () => {
    await run(["init"]);
    await seed("gh:1", "alpha");
    const { code, out } = await run(["store", "info", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.eventBreakdown).toBeUndefined();
  });

  test("--json emits a machine-readable snapshot", async () => {
    await run(["init"]);
    await seed("gh:1", "alpha");
    const { code, out } = await run(["store", "info", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.events).toBe(1);
    expect(parsed.fileSizeBytes).toBeGreaterThan(0);
    const sources = parsed.projections.find((p: { table: string }) => p.table === "sources");
    expect(sources.rows).toBe(1);
    expect(parsed.ftsRows).toBe(1);
  });
});
