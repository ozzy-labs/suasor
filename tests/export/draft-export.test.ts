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

  test("discloses composedViaRemoteSidecar when an Office format uses a remote sidecar (#436)", async () => {
    const out = await draftExport(
      store,
      { content: "# Doc\n\nbody", filename: "spec", format: "docx" },
      { exportDir, composer: fakeComposer(), composerRemote: true },
    );
    expect(out.status).toBe("exported");
    expect(out.composedViaRemoteSidecar).toBe(true);
  });

  test("omits composedViaRemoteSidecar for a local composer", async () => {
    const local = await draftExport(
      store,
      { content: "x", filename: "loc", format: "docx" },
      { exportDir, composer: fakeComposer(), composerRemote: false },
    );
    expect(local.composedViaRemoteSidecar).toBeUndefined();
  });

  test("md/txt never disclose remote egress even if composerRemote is set (no composer call)", async () => {
    const calls: { content: string; format: OfficeFormat }[] = [];
    const out = await draftExport(
      store,
      { content: "x", filename: "note", format: "md" },
      { exportDir, composer: fakeComposer(calls), composerRemote: true },
    );
    expect(out.composedViaRemoteSidecar).toBeUndefined();
    expect(calls).toEqual([]); // md is written directly; the composer is never touched
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

describe("symlink containment (Issue #512 / ADR-0025 §3/§4)", () => {
  test("rejects an export dir that reaches a connector root through a symlink", async () => {
    const { mkdtempSync, mkdirSync, symlinkSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const base = mkdtempSync(join(tmpdir(), "suasor-export-link-"));
    try {
      // A local connector root, and a symlink that points inside it — the shape
      // a Dropbox / OneDrive / iCloud folder takes in practice.
      const root = join(base, "synced-root");
      mkdirSync(join(root, "drafts"), { recursive: true });
      const link = join(base, "exports");
      symlinkSync(join(root, "drafts"), link);

      const store = Store.open({ path: ":memory:" });
      try {
        // path.resolve() alone sees two unrelated strings and lets this through,
        // recreating the re-ingest loop ADR-0025 exists to prevent.
        await expect(
          draftExport(
            store,
            { content: "hello", filename: "note.md", format: "md" },
            { exportDir: link, localRoots: [root] },
          ),
        ).rejects.toThrow(/inside local connector root/);
      } finally {
        store.close();
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("still allows a genuinely separate export dir", async () => {
    const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const base = mkdtempSync(join(tmpdir(), "suasor-export-ok-"));
    try {
      const root = join(base, "connector-root");
      const out = join(base, "exports");
      mkdirSync(root, { recursive: true });
      const store = Store.open({ path: ":memory:" });
      try {
        const result = await draftExport(
          store,
          { content: "hello", filename: "note.md", format: "md" },
          { exportDir: out, localRoots: [root] },
        );
        expect(result.path).toContain("note.md");
      } finally {
        store.close();
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("works when the export dir does not exist yet", async () => {
    const { mkdtempSync, mkdirSync, symlinkSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const base = mkdtempSync(join(tmpdir(), "suasor-export-missing-"));
    try {
      // The leaf is absent (nothing exported yet) but its parent is a symlink
      // into the connector root — the check must still dereference the parent.
      const root = join(base, "synced-root");
      mkdirSync(root, { recursive: true });
      const link = join(base, "linked");
      symlinkSync(root, link);
      const store = Store.open({ path: ":memory:" });
      try {
        await expect(
          draftExport(
            store,
            { content: "hi", filename: "n.md", format: "md" },
            { exportDir: join(link, "not-created-yet"), localRoots: [root] },
          ),
        ).rejects.toThrow(/inside local connector root/);
      } finally {
        store.close();
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
