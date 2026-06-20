/**
 * `draft.export` local draft export (ADR-0025). Verifies sandbox writes, the
 * body-less DraftExported audit event, filename guards, local-root overlap
 * rejection, non-destructive collision suffixes, and replay safety.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/db/index.ts";
import { DraftExportError, draftExport } from "../../src/export/draft-export.ts";

let store: Store;
let dir: string;
let exportDir: string;

beforeEach(() => {
  store = Store.open({ path: ":memory:" });
  dir = mkdtempSync(join(tmpdir(), "suasor-export-"));
  exportDir = join(dir, "exports");
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function events(): { type: string; payload: string }[] {
  return store.connection.sqlite.query("SELECT type, payload FROM events ORDER BY seq").all() as {
    type: string;
    payload: string;
  }[];
}

describe("draftExport (ADR-0025)", () => {
  test("writes the file into the sandbox and appends a body-less DraftExported", () => {
    const out = draftExport(
      store,
      { content: "# Reply\n\nhello", filename: "reply", format: "md", sourceExternalId: "gh:1" },
      { exportDir },
    );
    expect(out.status).toBe("exported");
    expect(out.path).toBe(join(exportDir, "reply.md"));
    expect(readFileSync(out.path, "utf8")).toBe("# Reply\n\nhello");

    const ev = events().find((e) => e.type === "DraftExported");
    expect(ev).toBeDefined();
    const payload = JSON.parse(ev?.payload ?? "{}");
    expect(payload.path).toBe(out.path);
    expect(payload.format).toBe("md");
    expect(payload.sourceExternalId).toBe("gh:1");
    expect(payload.body).toBeUndefined(); // content-minimization: no body in the event
  });

  test("adds the format extension when missing, keeps it when present", () => {
    expect(
      draftExport(store, { content: "x", filename: "a", format: "txt" }, { exportDir }).path,
    ).toBe(join(exportDir, "a.txt"));
    expect(
      draftExport(store, { content: "x", filename: "b.md", format: "md" }, { exportDir }).path,
    ).toBe(join(exportDir, "b.md"));
  });

  test("rejects path-separator / traversal / absolute filenames", () => {
    for (const bad of ["../escape", "sub/dir.md", "/abs.md", "..", "a\\b"]) {
      expect(() =>
        draftExport(store, { content: "x", filename: bad, format: "md" }, { exportDir }),
      ).toThrow(DraftExportError);
    }
  });

  test("rejects an export dir nested under a local connector root (re-ingest loop)", () => {
    const root = dir; // exportDir = <dir>/exports is inside <dir>
    expect(() =>
      draftExport(
        store,
        { content: "x", filename: "a", format: "md" },
        { exportDir, localRoots: [root] },
      ),
    ).toThrow(DraftExportError);
  });

  test("collisions get a numeric suffix (non-destructive)", () => {
    const a = draftExport(
      store,
      { content: "first", filename: "note", format: "md" },
      { exportDir },
    );
    const b = draftExport(
      store,
      { content: "second", filename: "note", format: "md" },
      { exportDir },
    );
    const c = draftExport(
      store,
      { content: "third", filename: "note", format: "md" },
      { exportDir },
    );
    expect(a.path).toBe(join(exportDir, "note.md"));
    expect(b.path).toBe(join(exportDir, "note-1.md"));
    expect(c.path).toBe(join(exportDir, "note-2.md"));
    // The original is untouched.
    expect(readFileSync(a.path, "utf8")).toBe("first");
    expect(readFileSync(b.path, "utf8")).toBe("second");
  });

  test("creates the export dir if absent", () => {
    expect(existsSync(exportDir)).toBe(false);
    draftExport(store, { content: "x", filename: "a", format: "md" }, { exportDir });
    expect(existsSync(exportDir)).toBe(true);
  });

  test("DraftExported folds to no projection and survives replay (no drift)", () => {
    draftExport(store, { content: "x", filename: "a", format: "md" }, { exportDir });
    // Rebuild projections from the event log — the no-op reducer must not throw
    // or fabricate state, and must not re-write the file.
    expect(() => store.rebuild()).not.toThrow();
  });
});
