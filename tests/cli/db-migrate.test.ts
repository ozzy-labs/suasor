/**
 * `suasor db migrate` CLI wiring (apply the projection schema, docs/design/cli.md).
 * Runs end-to-end against a temp config dir so the on-disk SQLite store is really
 * created. The contract: migrate creates the event store + projections + FTS
 * index, is idempotent (re-running is a no-op, ADR-0002), and honours --no-vec
 * (Issue #268).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCli } from "../../src/cli/index.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "suasor-cli-db-migrate-"));
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

describe("suasor db migrate", () => {
  test("--help lists the db migrate command", async () => {
    const { code, out } = await run(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("db migrate");
  });

  test("a fresh DB: applies the projection schema, creates the store file, exits 0", async () => {
    const { code, out } = await run(["db", "migrate"]);
    expect(code).toBe(0);
    expect(out).toContain("Applied projection schema");
    expect(existsSync(join(dir, "suasor.db"))).toBe(true);
  });

  test("idempotent: re-running on an existing DB is a no-op (ADR-0002)", async () => {
    const first = await run(["db", "migrate"]);
    expect(first.code).toBe(0);

    const dbPath = join(dir, "suasor.db");
    // Seed an append-only event so we can prove migrate never truncates data.
    const { Store } = await import("../../src/db/index.ts");
    const store = Store.open({ path: dbPath, embeddingDim: 1024 });
    store.record({
      type: "SourceObserved",
      externalId: "gh:1",
      sourceType: "github_issue",
      body: "keep me across a re-migrate",
      observedAt: "2026-06-14T00:00:00.000Z",
      fingerprint: "gh:1",
      meta: {},
    });
    store.close();
    const sizeBefore = statSync(dbPath).size;

    // Re-running succeeds and does not throw on the already-present DDL.
    const second = await run(["db", "migrate"]);
    expect(second.code).toBe(0);
    expect(second.out).toContain("Applied projection schema");

    // The pre-existing event survives — additive DDL never drops the event log.
    const reopened = Store.open({ path: dbPath, embeddingDim: 1024 });
    const row = reopened.connection.sqlite.query("SELECT COUNT(*) AS n FROM events").get() as {
      n: number;
    };
    reopened.close();
    expect(row.n).toBeGreaterThanOrEqual(1);
    // The DB only ever grows (additive) — never shrinks past the seeded state.
    expect(statSync(dbPath).size).toBeGreaterThanOrEqual(sizeBefore);
  });

  test("--no-vec skips the sqlite-vec substrate but still applies the schema", async () => {
    const { code, out } = await run(["db", "migrate", "--no-vec"]);
    expect(code).toBe(0);
    expect(out).toContain("Applied projection schema");
    expect(existsSync(join(dir, "suasor.db"))).toBe(true);
  });
});
