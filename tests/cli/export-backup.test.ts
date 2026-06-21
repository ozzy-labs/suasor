/**
 * `suasor export backup` CLI wiring (Issue #280). Runs end-to-end against a temp
 * config dir; asserts both formats produce a consistent, restorable snapshot,
 * the integrity (event count) holds, and the read-only / error paths behave.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCli } from "../../src/cli/index.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "suasor-cli-backup-"));
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

/** Seed an event into the db the CLI will back up. */
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

describe("suasor export backup", () => {
  test("--help lists the command", async () => {
    const { code, out } = await run(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("export backup");
  });

  test("errors when the database does not exist", async () => {
    await run(["init"]);
    rmSync(join(dir, "suasor.db"), { force: true });
    rmSync(join(dir, "suasor.db-wal"), { force: true });
    rmSync(join(dir, "suasor.db-shm"), { force: true });
    const { code, err } = await run(["export", "backup"]);
    expect(code).toBe(1);
    expect(err).toContain("database not found");
  });

  test("rejects an unknown --format", async () => {
    await run(["init"]);
    const { code, err } = await run(["export", "backup", "--format", "zip"]);
    expect(code).toBe(1);
    expect(err).toContain("--format must be");
  });

  test("writes a consistent sqlite snapshot to --out", async () => {
    await run(["init"]);
    await seed("gh:1", "alpha");
    await seed("gh:2", "beta");
    const out = join(dir, "backup.db");
    const { code, out: stdout } = await run(["export", "backup", "--out", out]);
    expect(code).toBe(0);
    expect(stdout).toContain("backup written");
    expect(stdout).toContain("events: 2");
    expect(existsSync(out)).toBe(true);

    // The snapshot is a real, openable store carrying the same data.
    const { Store } = await import("../../src/db/index.ts");
    const restored = Store.open({ path: out });
    const events = restored.connection.sqlite
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events")
      .get();
    const sources = restored.connection.sqlite
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sources")
      .get();
    restored.close();
    expect(events?.n).toBe(2);
    expect(sources?.n).toBe(2);
  });

  test("default --out lands a timestamped file beside the database", async () => {
    await run(["init"]);
    await seed("gh:1", "alpha");
    const { code, out } = await run(["export", "backup"]);
    expect(code).toBe(0);
    const made = readdirSync(dir).filter(
      (f) => f.startsWith("suasor-backup-") && f.endsWith(".db"),
    );
    expect(made.length).toBe(1);
    expect(out).toContain("backup written");
  });

  test("--format tgz produces a gzip archive that extracts to a valid store", async () => {
    await run(["init"]);
    await seed("gh:1", "alpha");
    const out = join(dir, "backup.tgz");
    const { code } = await run(["export", "backup", "--format", "tgz", "--out", out]);
    expect(code).toBe(0);
    expect(existsSync(out)).toBe(true);

    const ex = mkdtempSync(join(tmpdir(), "suasor-backup-extract-"));
    try {
      const proc = Bun.spawnSync(["tar", "-xzf", out, "-C", ex]);
      expect(proc.exitCode).toBe(0);
      const { Store } = await import("../../src/db/index.ts");
      const restored = Store.open({ path: join(ex, "suasor.db") });
      const events = restored.connection.sqlite
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events")
        .get();
      restored.close();
      expect(events?.n).toBe(1);
    } finally {
      rmSync(ex, { recursive: true, force: true });
    }
  });

  test("refuses to overwrite an existing --out", async () => {
    await run(["init"]);
    await seed("gh:1", "alpha");
    const out = join(dir, "backup.db");
    await run(["export", "backup", "--out", out]);
    const { code, err } = await run(["export", "backup", "--out", out]);
    expect(code).toBe(1);
    expect(err).toContain("refusing to overwrite");
  });

  test("is read-only: the live store is unchanged after a backup", async () => {
    await run(["init"]);
    await seed("gh:1", "alpha");
    const { Store } = await import("../../src/db/index.ts");
    const before = (() => {
      const s = Store.open({ path: join(dir, "suasor.db") });
      const n = s.connection.sqlite
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events")
        .get();
      s.close();
      return n?.n;
    })();
    await run(["export", "backup", "--out", join(dir, "b.db")]);
    const after = (() => {
      const s = Store.open({ path: join(dir, "suasor.db") });
      const n = s.connection.sqlite
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events")
        .get();
      s.close();
      return n?.n;
    })();
    expect(after).toBe(before);
  });
});
