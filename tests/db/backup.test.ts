/**
 * Store backup service (Issue #280). Asserts both formats produce a consistent,
 * restorable snapshot with the same event count, the overwrite guard, the
 * non-Suasor-DB guard, and the default-name helpers.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backupBasename,
  backupStore,
  backupStoreFile,
  defaultBackupDir,
  defaultBackupName,
} from "../../src/db/backup.ts";
import { Store } from "../../src/db/index.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "suasor-backup-svc-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seededStore(): Store {
  const store = Store.open({ path: join(dir, "suasor.db") });
  for (const id of ["gh:1", "gh:2", "gh:3"]) {
    store.record({
      type: "SourceObserved",
      externalId: id,
      sourceType: "github_issue",
      body: `body-${id}`,
      observedAt: "2026-06-14T00:00:00.000Z",
      fingerprint: id,
      meta: {},
    });
  }
  return store;
}

describe("backupStore", () => {
  test("sqlite format produces a restorable snapshot with matching events", async () => {
    const store = seededStore();
    const out = join(dir, "backup.db");
    const result = await backupStore(store.connection.sqlite, out, "sqlite");
    store.close();

    expect(result.format).toBe("sqlite");
    expect(result.events).toBe(3);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(existsSync(out)).toBe(true);

    const restored = Store.open({ path: out });
    const sources = restored.connection.sqlite
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sources")
      .get();
    restored.close();
    expect(sources?.n).toBe(3);
  });

  test("defaults to sqlite format", async () => {
    const store = seededStore();
    const result = await backupStore(store.connection.sqlite, join(dir, "b.db"));
    store.close();
    expect(result.format).toBe("sqlite");
  });

  test("tgz format produces a gzip archive that extracts to a valid store", async () => {
    const store = seededStore();
    const out = join(dir, "backup.tgz");
    const result = await backupStore(store.connection.sqlite, out, "tgz");
    store.close();
    expect(result.format).toBe("tgz");
    expect(result.events).toBe(3);

    const ex = mkdtempSync(join(tmpdir(), "suasor-backup-svc-ex-"));
    try {
      const proc = Bun.spawnSync(["tar", "-xzf", out, "-C", ex]);
      expect(proc.exitCode).toBe(0);
      const restored = Store.open({ path: join(ex, "suasor.db") });
      const events = restored.connection.sqlite
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events")
        .get();
      restored.close();
      expect(events?.n).toBe(3);
    } finally {
      rmSync(ex, { recursive: true, force: true });
    }
  });

  test("refuses to overwrite an existing destination", async () => {
    const store = seededStore();
    const out = join(dir, "backup.db");
    await backupStore(store.connection.sqlite, out, "sqlite");
    await expect(backupStore(store.connection.sqlite, out, "sqlite")).rejects.toThrow(
      /refusing to overwrite/,
    );
    store.close();
  });

  test("backs up an empty store (0 events) consistently", async () => {
    const store = Store.open({ path: join(dir, "suasor.db") });
    const result = await backupStore(store.connection.sqlite, join(dir, "empty.db"), "sqlite");
    store.close();
    expect(result.events).toBe(0);
  });

  test("rejects a database without an events table (not a Suasor store)", async () => {
    const bogus = new Database(join(dir, "bogus.db"), { create: true });
    bogus.exec("CREATE TABLE foo (x);");
    await expect(backupStore(bogus, join(dir, "out.db"), "sqlite")).rejects.toThrow();
    bogus.close();
  });
});

describe("backupStoreFile (read-only, no side effects)", () => {
  test("backs up a store file without mutating it", async () => {
    const store = seededStore();
    store.close();
    const out = join(dir, "b.db");
    const result = await backupStoreFile(join(dir, "suasor.db"), out, "sqlite");
    expect(result.events).toBe(3);
    const restored = Store.open({ path: out });
    expect(
      restored.connection.sqlite.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sources").get()
        ?.n,
    ).toBe(3);
    restored.close();
  });

  test("does not run schema migrations on a legacy store (no ADD COLUMN side effect)", async () => {
    // Build a legacy `tasks` table missing the ADR-0028 due_date/priority columns
    // plus a minimal events table, then back it up read-only and assert the source
    // schema is unchanged (Store.open would have ALTER'd it; backupStoreFile must not).
    const legacy = new Database(join(dir, "legacy.db"), { create: true });
    legacy.exec("CREATE TABLE events (seq INTEGER PRIMARY KEY, type TEXT NOT NULL);");
    legacy.exec("INSERT INTO events (type) VALUES ('SourceObserved');");
    legacy.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL);");
    legacy.close();

    const result = await backupStoreFile(join(dir, "legacy.db"), join(dir, "legacy-bk.db"));
    expect(result.events).toBe(1);

    // Re-open the SOURCE and confirm tasks still lacks due_date/priority.
    const after = new Database(join(dir, "legacy.db"), { readonly: true });
    const cols = after
      .query<{ name: string }, []>("PRAGMA table_info(tasks)")
      .all()
      .map((c) => c.name);
    after.close();
    expect(cols).toEqual(["id", "title"]);
    expect(cols).not.toContain("due_date");
  });
});

describe("default-name helpers", () => {
  test("defaultBackupName uses a filesystem-safe timestamp and format suffix", () => {
    const now = new Date("2026-06-21T12:34:56.789Z");
    expect(defaultBackupName("sqlite", now)).toBe("suasor-backup-2026-06-21_12-34-56-789.db");
    expect(defaultBackupName("tgz", now)).toBe("suasor-backup-2026-06-21_12-34-56-789.tgz");
  });

  test("defaultBackupDir returns the database's directory", () => {
    expect(defaultBackupDir("/a/b/suasor.db")).toBe("/a/b");
  });

  test("backupBasename returns the file name only", () => {
    expect(backupBasename("/a/b/c.db")).toBe("c.db");
  });
});
