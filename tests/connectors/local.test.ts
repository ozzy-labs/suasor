import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SourceRecord, SyncContext } from "../../src/connectors/contract.ts";
import {
  createLocalConnector,
  LocalConnectorConfig,
  type LocalFileEntry,
  type LocalWalkerLike,
} from "../../src/connectors/local.ts";

const ctx: SyncContext = { cursor: null, secret: async () => null };

async function collect(it: AsyncIterable<SourceRecord>): Promise<SourceRecord[]> {
  const out: SourceRecord[] = [];
  for await (const r of it) out.push(r);
  return out;
}

/** A fake walker returning preset entries per root (no real FS). */
function fakeWalker(byRoot: Record<string, LocalFileEntry[]>): () => LocalWalkerLike {
  return () => ({
    async *walk(root) {
      for (const entry of byRoot[root] ?? []) yield entry;
    },
  });
}

describe("LocalConnectorConfig", () => {
  test("defaults: empty roots, text extensions, 1MB cap", () => {
    const c = LocalConnectorConfig.parse({});
    expect(c.roots).toEqual([]);
    expect(c.textExtensions).toContain(".md");
    expect(c.maxBytes).toBe(1_000_000);
  });
  test("rejects empty root strings", () => {
    expect(() => LocalConnectorConfig.parse({ roots: [""] })).toThrow();
  });
  test("rejects non-positive maxBytes", () => {
    expect(() => LocalConnectorConfig.parse({ maxBytes: 0 })).toThrow();
  });
});

describe("Local connector — record mapping (ADR-0007/0023 identity)", () => {
  test("maps a file to local_file with a stable path-hash id", async () => {
    const path = "/mnt/box/notes/a.md";
    const entry: LocalFileEntry = {
      path,
      name: "a.md",
      mtimeMs: 1_700_000_000_000,
      size: 5,
      content: "hello",
    };
    const connector = createLocalConnector(
      { roots: ["/mnt/box"] },
      { walkerFactory: fakeWalker({ "/mnt/box": [entry] }) },
    );
    const [rec] = await collect(connector.sync(ctx));
    const expectedId = `local:${createHash("sha1").update(path).digest("hex")}`;
    expect(rec?.externalId).toBe(expectedId);
    expect(rec?.sourceType).toBe("local_file");
    expect(rec?.body).toBe("a.md\n\nhello");
    expect(rec?.meta).toMatchObject({ path, name: "a.md", size: 5 });
    expect(rec?.observedAt).toBe(new Date(1_700_000_000_000).toISOString());
  });

  test("name-only body when content is not read (e.g. binary / oversized)", async () => {
    const entry: LocalFileEntry = {
      path: "/r/photo.png",
      name: "photo.png",
      mtimeMs: 1,
      size: 9_999_999,
    };
    const connector = createLocalConnector(
      { roots: ["/r"] },
      { walkerFactory: fakeWalker({ "/r": [entry] }) },
    );
    const [rec] = await collect(connector.sync(ctx));
    expect(rec?.body).toBe("photo.png");
  });
});

describe("Local connector — fingerprint diff (FR-ING-3)", () => {
  test("content edit changes the fingerprint while identity is stable", async () => {
    const base: LocalFileEntry = {
      path: "/r/x.txt",
      name: "x.txt",
      mtimeMs: 100,
      size: 2,
      content: "v1",
    };
    const edited: LocalFileEntry = { ...base, mtimeMs: 200, size: 10, content: "v2 updated" };
    const before = await collect(
      createLocalConnector({ roots: ["/r"] }, { walkerFactory: fakeWalker({ "/r": [base] }) }).sync(
        ctx,
      ),
    );
    const after = await collect(
      createLocalConnector(
        { roots: ["/r"] },
        { walkerFactory: fakeWalker({ "/r": [edited] }) },
      ).sync(ctx),
    );
    expect(before[0]?.externalId).toBe(after[0]?.externalId); // same identity
    expect(before[0]?.fingerprint).not.toBe(after[0]?.fingerprint); // changed → update
  });

  test("unchanged file yields a stable fingerprint across passes (re-sync skip)", async () => {
    const entry: LocalFileEntry = {
      path: "/r/y.txt",
      name: "y.txt",
      mtimeMs: 5,
      size: 3,
      content: "abc",
    };
    const a = await collect(
      createLocalConnector(
        { roots: ["/r"] },
        { walkerFactory: fakeWalker({ "/r": [entry] }) },
      ).sync(ctx),
    );
    const b = await collect(
      createLocalConnector(
        { roots: ["/r"] },
        { walkerFactory: fakeWalker({ "/r": [{ ...entry }] }) },
      ).sync(ctx),
    );
    expect(a[0]?.fingerprint).toBe(b[0]?.fingerprint);
  });
});

describe("Local connector — guards", () => {
  test("no roots yields nothing (and never builds a walker)", async () => {
    let built = false;
    const connector = createLocalConnector(
      { roots: [] },
      {
        walkerFactory: () => {
          built = true;
          return fakeWalker({})();
        },
      },
    );
    expect(await collect(connector.sync(ctx))).toEqual([]);
    expect(built).toBe(false);
  });

  test("de-dups identical paths reached via overlapping roots", async () => {
    const shared: LocalFileEntry = { path: "/a/shared.md", name: "shared.md", mtimeMs: 1, size: 1 };
    const connector = createLocalConnector(
      { roots: ["/a", "/a-again"] },
      { walkerFactory: fakeWalker({ "/a": [shared], "/a-again": [shared] }) },
    );
    const recs = await collect(connector.sync(ctx));
    expect(recs).toHaveLength(1);
  });

  test("finalize returns a null cursor (fingerprint-based)", async () => {
    const connector = createLocalConnector({ roots: [] });
    expect((await connector.finalize?.())?.cursor).toBeNull();
  });
});

describe("Local connector — default walker against a real temp dir", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "suasor-local-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("recurses subdirectories and reads text files, name-only for others", async () => {
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "top.md"), "# Top");
    writeFileSync(join(dir, "sub", "nested.txt"), "nested body");
    writeFileSync(join(dir, "sub", "image.bin"), "raw");
    const connector = createLocalConnector({ roots: [dir] });
    const recs = await collect(connector.sync(ctx));
    const byName = Object.fromEntries(recs.map((r) => [(r.meta as { name: string }).name, r]));
    expect(byName["top.md"]?.body).toBe("top.md\n\n# Top");
    expect(byName["nested.txt"]?.body).toBe("nested.txt\n\nnested body");
    // .bin is not a configured text extension → name-only.
    expect(byName["image.bin"]?.body).toBe("image.bin");
  });

  test("oversized text file falls back to name-only via maxBytes", async () => {
    writeFileSync(join(dir, "big.md"), "x".repeat(100));
    const connector = createLocalConnector({ roots: [dir], maxBytes: 10 });
    const [rec] = await collect(connector.sync(ctx));
    expect(rec?.body).toBe("big.md");
  });

  test("re-sync with no change keeps an identical fingerprint", async () => {
    const file = join(dir, "stable.md");
    writeFileSync(file, "same");
    // Pin mtime so the fingerprint is deterministic across both passes.
    const when = new Date(1_700_000_000_000);
    utimesSync(file, when, when);
    const connector = createLocalConnector({ roots: [dir] });
    const a = await collect(connector.sync(ctx));
    const b = await collect(connector.sync(ctx));
    expect(a[0]?.fingerprint).toBe(b[0]?.fingerprint);
  });

  test("warns and skips a non-existent root without throwing", async () => {
    const warnings: string[] = [];
    const connector = createLocalConnector({ roots: [join(dir, "does-not-exist")] });
    const recs = await collect(connector.sync({ ...ctx, onWarn: (m) => warnings.push(m) }));
    expect(recs).toEqual([]);
    expect(warnings.some((w) => w.includes("cannot stat root"))).toBe(true);
  });
});

describe("Local connector — extractable marking (ADR-0024)", () => {
  test("attaches an extractable handle to Office/PDF entries (name-only body)", async () => {
    const entry: LocalFileEntry = {
      path: "/mnt/box/specs/design.docx",
      name: "design.docx",
      mtimeMs: 1_700_000_000_000,
      size: 4096,
    };
    const connector = createLocalConnector(
      { roots: ["/mnt/box"] },
      { walkerFactory: fakeWalker({ "/mnt/box": [entry] }) },
    );
    const [rec] = await collect(connector.sync(ctx));
    expect(rec?.body).toBe("design.docx"); // name-only until extracted
    expect(rec?.extractable?.filename).toBe("design.docx");
    expect(rec?.extractable?.byteSize).toBe(4096);
    expect(typeof rec?.extractable?.readBytes).toBe("function");
  });

  test("does not attach extractable to text or unknown extensions", async () => {
    const entries: LocalFileEntry[] = [
      { path: "/r/a.md", name: "a.md", mtimeMs: 1, size: 5, content: "hi" },
      { path: "/r/b.png", name: "b.png", mtimeMs: 1, size: 9 },
    ];
    const connector = createLocalConnector(
      { roots: ["/r"] },
      { walkerFactory: fakeWalker({ "/r": entries }) },
    );
    const recs = await collect(connector.sync(ctx));
    expect(recs.every((r) => r.extractable === undefined)).toBe(true);
  });
});
