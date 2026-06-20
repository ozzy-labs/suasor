import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_VEC_TABLE,
  initSchema,
  openDatabase,
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
    for (const t of ["sources", "tasks", "sync_runs", "decisions", "inbox", "links"]) {
      expect(tableExists(db, t)).toBe(true);
    }
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
