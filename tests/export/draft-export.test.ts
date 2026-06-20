/**
 * `draft.export` local draft export (ADR-0025 / #138). Verifies sandbox writes,
 * the body-less DraftExported audit event, filename guards, local-root overlap
 * rejection, non-destructive collision suffixes, replay safety, and Office-format
 * composition (md→docx via a sidecar composer; error when disabled).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/db/index.ts";
import type { Composer, OfficeFormat } from "../../src/export/compose.ts";
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

/** Composer stub that records calls and returns deterministic bytes. */
function fakeComposer(calls: { content: string; format: OfficeFormat }[] = []): Composer {
  return {
    compose: (content, format) => {
      calls.push({ content, format });
      return Promise.resolve(new TextEncoder().encode(`${format}-bytes:${content}`));
    },
  };
}

describe("draftExport (ADR-0025 / #138)", () => {
  test("writes md into the sandbox and appends a body-less DraftExported", async () => {
    const out = await draftExport(
      store,
      { content: "# Reply\n\nhello", filename: "reply", format: "md", sourceExternalId: "gh:1" },
      { exportDir },
    );
    expect(out.status).toBe("exported");
    expect(out.path).toBe(join(exportDir, "reply.md"));
    expect(readFileSync(out.path, "utf8")).toBe("# Reply\n\nhello");

    const ev = events().find((e) => e.type === "DraftExported");
    const payload = JSON.parse(ev?.payload ?? "{}");
    expect(payload.path).toBe(out.path);
    expect(payload.format).toBe("md");
    expect(payload.sourceExternalId).toBe("gh:1");
    expect(payload.body).toBeUndefined(); // content-minimization: no body in the event
  });

  test("adds the format extension when missing, keeps it when present", async () => {
    expect(
      (await draftExport(store, { content: "x", filename: "a", format: "txt" }, { exportDir }))
        .path,
    ).toBe(join(exportDir, "a.txt"));
    expect(
      (await draftExport(store, { content: "x", filename: "b.md", format: "md" }, { exportDir }))
        .path,
    ).toBe(join(exportDir, "b.md"));
  });

  test("rejects path-separator / traversal / absolute filenames", async () => {
    for (const bad of ["../escape", "sub/dir.md", "/abs.md", "..", "a\\b"]) {
      await expect(
        draftExport(store, { content: "x", filename: bad, format: "md" }, { exportDir }),
      ).rejects.toBeInstanceOf(DraftExportError);
    }
  });

  test("rejects an export dir nested under a local connector root (re-ingest loop)", async () => {
    await expect(
      draftExport(
        store,
        { content: "x", filename: "a", format: "md" },
        { exportDir, localRoots: [dir] },
      ),
    ).rejects.toBeInstanceOf(DraftExportError);
  });

  test("collisions get a numeric suffix (non-destructive)", async () => {
    const a = await draftExport(
      store,
      { content: "first", filename: "note", format: "md" },
      { exportDir },
    );
    const b = await draftExport(
      store,
      { content: "second", filename: "note", format: "md" },
      { exportDir },
    );
    const c = await draftExport(
      store,
      { content: "third", filename: "note", format: "md" },
      { exportDir },
    );
    expect(a.path).toBe(join(exportDir, "note.md"));
    expect(b.path).toBe(join(exportDir, "note-1.md"));
    expect(c.path).toBe(join(exportDir, "note-2.md"));
    expect(readFileSync(a.path, "utf8")).toBe("first");
  });

  test("creates the export dir if absent", async () => {
    expect(existsSync(exportDir)).toBe(false);
    await draftExport(store, { content: "x", filename: "a", format: "md" }, { exportDir });
    expect(existsSync(exportDir)).toBe(true);
  });

  test("DraftExported folds to no projection and survives replay (no drift)", async () => {
    await draftExport(store, { content: "x", filename: "a", format: "md" }, { exportDir });
    expect(() => store.rebuild()).not.toThrow();
  });

  test("composes Office formats via the sidecar and writes the returned bytes (#138)", async () => {
    const calls: { content: string; format: OfficeFormat }[] = [];
    const out = await draftExport(
      store,
      { content: "# Doc\n\nbody", filename: "spec", format: "docx" },
      { exportDir, composer: fakeComposer(calls) },
    );
    expect(out.path).toBe(join(exportDir, "spec.docx"));
    expect(calls).toEqual([{ content: "# Doc\n\nbody", format: "docx" }]);
    expect(readFileSync(out.path, "utf8")).toBe("docx-bytes:# Doc\n\nbody");
    expect(
      JSON.parse(events().find((e) => e.type === "DraftExported")?.payload ?? "{}").format,
    ).toBe("docx");
  });

  test("errors on an Office format when no composer is configured", async () => {
    await expect(
      draftExport(store, { content: "x", filename: "a", format: "docx" }, { exportDir }),
    ).rejects.toBeInstanceOf(DraftExportError);
    // Nothing written, no event.
    expect(existsSync(join(exportDir, "a.docx"))).toBe(false);
    expect(events().some((e) => e.type === "DraftExported")).toBe(false);
  });
});
