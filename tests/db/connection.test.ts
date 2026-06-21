import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_VEC_TABLE,
  initSchema,
  openDatabase,
  readVecDim,
  type SuasorDb,
} from "../../src/db/connection.ts";

let db: SuasorDb;

beforeEach(() => {
  db = openDatabase({ path: ":memory:" });
});

afterEach(() => {
  db.close();
});

function tableExists(db: SuasorDb, name: string): boolean {
  const row = db.sqlite
    .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = ?")
    .get(name);
  return (row?.n ?? 0) > 0;
}

describe("schema init", () => {
  test("creates the append-only events table", () => {
    expect(tableExists(db, "events")).toBe(true);
  });

  test("creates all projection tables", () => {
    for (const t of [
      "sources",
      "tasks",
      "sync_runs",
      "decisions",
      "inbox",
      "proposals",
      "commitments",
      "links",
      "persons",
      "person_identities",
    ]) {
      expect(tableExists(db, t)).toBe(true);
    }
  });

  test("creates the derived substrate sidecars (extraction_meta + embeddings_meta)", () => {
    // ADR-0024 extraction provenance + ADR-0006 embedding provenance are raw-DDL
    // substrate (not events, not drizzle-managed) but must exist after migrate.
    expect(tableExists(db, "extraction_meta")).toBe(true);
    expect(tableExists(db, "embeddings_meta")).toBe(true);
  });

  test("creates the sources_fts FTS5 virtual table (trigram)", () => {
    expect(tableExists(db, "sources_fts")).toBe(true);
    // It is a virtual table backed by fts5.
    const sql = db.sqlite
      .query<{ sql: string }, [string]>("SELECT sql FROM sqlite_master WHERE name = ?")
      .get("sources_fts");
    expect(sql?.sql.toLowerCase()).toContain("fts5");
    expect(sql?.sql.toLowerCase()).toContain("trigram");
  });

  test("creates the embeddings_vec_default vec0 virtual table", () => {
    expect(tableExists(db, DEFAULT_VEC_TABLE)).toBe(true);
    const sql = db.sqlite
      .query<{ sql: string }, [string]>("SELECT sql FROM sqlite_master WHERE name = ?")
      .get(DEFAULT_VEC_TABLE);
    expect(sql?.sql.toLowerCase()).toContain("vec0");
  });

  test("init is idempotent (re-open on same in-memory handle is a no-op DDL)", () => {
    // Re-running init via a fresh open shouldn't throw; verify a second open path.
    const db2 = openDatabase({ path: ":memory:" });
    expect(tableExists(db2, "events")).toBe(true);
    db2.close();
  });
});

describe("additive column migration (ADR-0028)", () => {
  function taskColumns(sqlite: Database): string[] {
    return sqlite
      .query<{ name: string }, []>("PRAGMA table_info(tasks)")
      .all()
      .map((c) => c.name);
  }

  test("adds tasks.due_date / tasks.priority to a pre-existing legacy table", () => {
    const sqlite = new Database(":memory:");
    // Simulate a pre-ADR-0028 tasks table (no scheduling columns).
    sqlite.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'proposed',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    sqlite
      .query("INSERT INTO tasks (id, title, state, created_at, updated_at) VALUES (?,?,?,?,?)")
      .run("legacy", "old", "open", "2026-06-14T00:00:00.000Z", "2026-06-14T00:00:00.000Z");
    expect(taskColumns(sqlite)).not.toContain("due_date");

    initSchema(sqlite);

    const cols = taskColumns(sqlite);
    expect(cols).toContain("due_date");
    expect(cols).toContain("priority");
    // The pre-existing row is preserved with NULL scheduling fields.
    const row = sqlite.query("SELECT due_date, priority FROM tasks WHERE id = 'legacy'").get() as {
      due_date: string | null;
      priority: string | null;
    };
    expect(row.due_date).toBeNull();
    expect(row.priority).toBeNull();
    sqlite.close();
  });

  test("ensureColumn is idempotent (re-running initSchema does not throw)", () => {
    const sqlite = new Database(":memory:");
    initSchema(sqlite);
    expect(() => initSchema(sqlite)).not.toThrow();
    expect(taskColumns(sqlite)).toContain("due_date");
    sqlite.close();
  });
});

describe("vec disabled", () => {
  test("skips vec0 creation when enableVec is false", () => {
    const noVec = openDatabase({ path: ":memory:", enableVec: false });
    expect(tableExists(noVec, "events")).toBe(true);
    expect(tableExists(noVec, DEFAULT_VEC_TABLE)).toBe(false);
    noVec.close();
  });
});

/**
 * The drizzle artifact (drizzle/0000_init_projections.sql) is a non-applied
 * reference (data-model.md "Migrations": the raw DDL in connection.ts is the
 * runtime source of truth). This guards against the two drifting: the artifact's
 * table/column set must equal the runtime drizzle-managed projection schema, so a
 * stale artifact (the original bug — missing 5 tables and columns) can't recur.
 */
describe("drizzle artifact ⇄ runtime schema parity", () => {
  // Tables drizzle-kit manages (src/db/schema.ts). The raw-DDL-only substrate
  // (events / sources_fts / vec0 / embeddings_meta / extraction_meta) is
  // intentionally out of drizzle scope and excluded from this parity check.
  const DRIZZLE_MANAGED = [
    "commitments",
    "decisions",
    "inbox",
    "links",
    "person_identities",
    "persons",
    "proposals",
    "sources",
    "sync_runs",
    "tasks",
  ] as const;

  function parseDrizzleSql(sql: string): Map<string, Set<string>> {
    const tables = new Map<string, Set<string>>();
    // Split on the statement-breakpoint markers drizzle emits between CREATEs.
    for (const stmt of sql.split("--> statement-breakpoint")) {
      const head = stmt.match(/CREATE TABLE `([^`]+)`\s*\(([\s\S]*)\)\s*;/);
      const table = head?.[1];
      const cols = head?.[2];
      if (!table || cols === undefined) continue;
      const columns = new Set<string>();
      for (const line of cols.split("\n")) {
        const col = line.trim().match(/^`([^`]+)`/);
        if (col?.[1]) columns.add(col[1]);
      }
      tables.set(table, columns);
    }
    return tables;
  }

  function runtimeColumns(sqlite: Database, table: string): Set<string> {
    return new Set(
      sqlite
        .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
        .all()
        .map((c) => c.name),
    );
  }

  test("the committed migration covers every drizzle-managed table with matching columns", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const sql = readFileSync(
      join(import.meta.dir, "../../drizzle/0000_init_projections.sql"),
      "utf8",
    );
    const artifact = parseDrizzleSql(sql);

    // Every drizzle-managed table is present in the artifact (no missing tables).
    expect([...artifact.keys()].sort()).toEqual([...DRIZZLE_MANAGED].sort());

    // Each table's column set matches the runtime DDL exactly (no missing/extra).
    const sqlite = new Database(":memory:");
    initSchema(sqlite);
    for (const table of DRIZZLE_MANAGED) {
      const artifactCols = [...(artifact.get(table) ?? new Set())].sort();
      const runtimeCols = [...runtimeColumns(sqlite, table)].sort();
      expect(artifactCols).toEqual(runtimeCols);
    }
    sqlite.close();
  });
});

describe("readVecDim (Issue #294)", () => {
  test("reports the dimension the vec0 table was created with (default 1024)", () => {
    expect(readVecDim(db.sqlite)).toBe(1024);
  });

  test("reflects a non-default dimension passed at open", () => {
    const wide = openDatabase({ path: ":memory:", embeddingDim: 1536 });
    expect(readVecDim(wide.sqlite)).toBe(1536);
    wide.close();
  });

  test("returns null when the vec0 table is absent (FTS-only store)", () => {
    const noVec = openDatabase({ path: ":memory:", enableVec: false });
    expect(readVecDim(noVec.sqlite)).toBeNull();
    noVec.close();
  });
});
