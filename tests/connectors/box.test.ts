import { describe, expect, test } from "bun:test";
import {
  type BoxClientLike,
  BoxConnectorConfig,
  type BoxPage,
  createBoxConnector,
} from "../../src/connectors/box.ts";
import type { SourceRecord, SyncContext } from "../../src/connectors/contract.ts";
import { syncConnector } from "../../src/connectors/index.ts";
import { Store } from "../../src/db/index.ts";
import type { Extractor } from "../../src/extraction/index.ts";

function fakeBox(
  pagesByFolder: Record<string, BoxPage[]>,
  downloads: Record<string, string> = {},
): {
  client: BoxClientLike;
  calls: Array<{ folderId: string; marker?: string }>;
  downloadCalls: string[];
} {
  const calls: Array<{ folderId: string; marker?: string }> = [];
  const downloadCalls: string[] = [];
  const cursors: Record<string, number> = {};
  const client: BoxClientLike = {
    async listFolder(folderId, marker) {
      calls.push({ folderId, marker });
      const list = pagesByFolder[folderId] ?? [];
      const idx = cursors[folderId] ?? 0;
      cursors[folderId] = idx + 1;
      return list[idx] ?? { files: [] };
    },
    async downloadFile(fileId) {
      downloadCalls.push(fileId);
      const content = downloads[fileId];
      if (content === undefined) throw new Error(`no download fixture for ${fileId}`);
      return new TextEncoder().encode(content);
    },
  };
  return { client, calls, downloadCalls };
}

function ctx(overrides: Partial<SyncContext> = {}): SyncContext {
  return {
    cursor: null,
    secret: async (name) => (name === "token" ? "dev-tok" : null),
    ...overrides,
  };
}

async function collect(it: AsyncIterable<SourceRecord>): Promise<SourceRecord[]> {
  const out: SourceRecord[] = [];
  for await (const r of it) out.push(r);
  return out;
}

describe("BoxConnectorConfig", () => {
  test("defaults: empty folders", () => {
    expect(BoxConnectorConfig.parse({}).folders).toEqual([]);
  });
});

describe("Box connector — record mapping (ADR-0007 identity)", () => {
  test("maps files to box_file with file-prefixed ids; body is filename-only", async () => {
    const { client } = fakeBox({
      "0": [
        {
          // No `size`/`sha1` reported → no extractable handle, no fingerprint.
          files: [{ id: "11", name: "report.txt", modifiedAt: "2026-06-10T00:00:00Z" }],
        },
      ],
    });
    const connector = createBoxConnector({ folders: ["0"] }, { clientFactory: () => client });
    const records = await collect(connector.sync(ctx()));
    expect(records).toHaveLength(1);
    expect(records[0]?.externalId).toBe("box:file:11");
    expect(records[0]?.sourceType).toBe("box_file");
    expect(records[0]?.body).toBe("report.txt");
    // No sha1 reported → no connector-supplied fingerprint: delta detection keys
    // off the body SHA-256 (sync service default), the filename (issue #36).
    expect(records[0]?.fingerprint).toBeUndefined();
    expect(records[0]?.extractable).toBeUndefined();
    expect(records[0]?.observedAt).toBe("2026-06-10T00:00:00Z");
  });
});

describe("Box connector — extraction handle + content fingerprint (ADR-0024)", () => {
  test("Office/PDF file with size carries an extractable handle and sha1 fingerprint", async () => {
    const { client, downloadCalls } = fakeBox(
      {
        "0": [
          {
            files: [
              {
                id: "42",
                name: "spec.docx",
                modifiedAt: "2026-06-10T00:00:00Z",
                size: 2048,
                sha1: "abc123",
              },
            ],
          },
        ],
      },
      { "42": "DOCX-BYTES" },
    );
    const connector = createBoxConnector({ folders: ["0"] }, { clientFactory: () => client });
    const records = await collect(connector.sync(ctx()));
    expect(records).toHaveLength(1);
    // Content sha1 drives delta detection (content change re-extracts, ADR-0024 §6).
    expect(records[0]?.fingerprint).toBe("abc123");
    expect(records[0]?.extractable?.filename).toBe("spec.docx");
    expect(records[0]?.extractable?.byteSize).toBe(2048);
    // readBytes is lazy: not called until the sync extraction stage drives it.
    expect(downloadCalls).toEqual([]);
    const bytes = await records[0]?.extractable?.readBytes();
    expect(new TextDecoder().decode(bytes)).toBe("DOCX-BYTES");
    expect(downloadCalls).toEqual(["42"]);
  });

  test("non-extractable extension gets no extractable handle (sha1 still fingerprints)", async () => {
    const { client } = fakeBox({
      "0": [{ files: [{ id: "9", name: "photo.png", size: 100, sha1: "deadbeef" }] }],
    });
    const connector = createBoxConnector({ folders: ["0"] }, { clientFactory: () => client });
    const records = await collect(connector.sync(ctx()));
    expect(records[0]?.extractable).toBeUndefined();
    expect(records[0]?.fingerprint).toBe("deadbeef");
  });

  test("extractable extension but missing size → no handle (cannot size-guard)", async () => {
    const { client } = fakeBox({
      "0": [{ files: [{ id: "7", name: "deck.pptx", sha1: "ff00" }] }],
    });
    const connector = createBoxConnector({ folders: ["0"] }, { clientFactory: () => client });
    const records = await collect(connector.sync(ctx()));
    expect(records[0]?.extractable).toBeUndefined();
    expect(records[0]?.fingerprint).toBe("ff00");
  });
});

describe("Box connector — pagination + fingerprint cursor", () => {
  test("follows nextMarker and returns null cursor", async () => {
    const { client, calls } = fakeBox({
      "0": [
        { files: [{ id: "1", name: "a" }], nextMarker: "m2" },
        { files: [{ id: "2", name: "b" }] },
      ],
    });
    const connector = createBoxConnector({ folders: ["0"] }, { clientFactory: () => client });
    const records = await collect(connector.sync(ctx()));
    expect(records).toHaveLength(2);
    expect(calls[1]?.marker).toBe("m2");
    expect((await connector.finalize?.())?.cursor).toBeNull();
  });
});

/** A fake whose `listFolder` throws for folder ids named in `failFolders`. */
function fakeFailingBox(opts: {
  pagesByFolder: Record<string, BoxPage[]>;
  failFolders: Record<string, Error>;
}): BoxClientLike {
  const cursors: Record<string, number> = {};
  return {
    async listFolder(folderId, _marker) {
      if (opts.failFolders[folderId]) throw opts.failFolders[folderId];
      const list = opts.pagesByFolder[folderId] ?? [];
      const idx = cursors[folderId] ?? 0;
      cursors[folderId] = idx + 1;
      return list[idx] ?? { files: [] };
    },
    async downloadFile() {
      return new Uint8Array(0);
    },
  };
}

describe("Box connector — per-resource error isolation (Issue #193)", () => {
  test("one folder failing is skipped; the rest stream; one aggregated warn", async () => {
    const client = fakeFailingBox({
      pagesByFolder: {
        "1": [{ files: [{ id: "f1", name: "a.pdf" }] }],
        "3": [{ files: [{ id: "f3", name: "c.pdf" }] }],
      },
      failFolders: { "2": new Error("403 Forbidden") },
    });
    const warns: string[] = [];
    const connector = createBoxConnector(
      { folders: ["1", "2", "3"] },
      { clientFactory: () => client },
    );
    const records = await collect(connector.sync(ctx({ onWarn: (m) => warns.push(m) })));
    expect(records.map((r) => r.externalId).sort()).toEqual(["box:file:f1", "box:file:f3"]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("2 folder OK, 1 failed (cursor preserved)");
    expect(warns[0]).toContain("2 (403 Forbidden)");
  });

  test("partial failure sets partialFailure + a summary line in finalize", async () => {
    const client = fakeFailingBox({
      pagesByFolder: { "1": [{ files: [{ id: "f1", name: "a" }] }] },
      failFolders: { "2": new Error("boom") },
    });
    const connector = createBoxConnector({ folders: ["1", "2"] }, { clientFactory: () => client });
    await collect(connector.sync(ctx({ onWarn: () => {} })));
    const result = await connector.finalize?.();
    expect(result?.cursor).toBeNull();
    expect(result?.partialFailure).toBe(true);
    expect(result?.summaryLines?.[0]).toBe("folders: 1=ok, 2=failed (cursor preserved)");
  });

  test("all folders failing throws", async () => {
    const client = fakeFailingBox({
      pagesByFolder: {},
      failFolders: { "1": new Error("403"), "2": new Error("404") },
    });
    const connector = createBoxConnector({ folders: ["1", "2"] }, { clientFactory: () => client });
    await expect(collect(connector.sync(ctx({ onWarn: () => {} })))).rejects.toThrow(/40[34]/);
  });

  test("a clean run sets no partialFailure", async () => {
    const client = fakeFailingBox({
      pagesByFolder: { "1": [{ files: [{ id: "f1", name: "a" }] }] },
      failFolders: {},
    });
    const connector = createBoxConnector({ folders: ["1"] }, { clientFactory: () => client });
    await collect(connector.sync(ctx()));
    const result = await connector.finalize?.();
    expect(result?.partialFailure).toBeUndefined();
  });
});

describe("Box connector — guards", () => {
  test("throws when no token is configured", async () => {
    const connector = createBoxConnector(
      { folders: ["0"] },
      { clientFactory: () => fakeBox({}).client },
    );
    await expect(collect(connector.sync(ctx({ secret: async () => null })))).rejects.toThrow(
      /no token configured/,
    );
  });

  test("no folders yields nothing (and never builds a client)", async () => {
    let built = false;
    const connector = createBoxConnector(
      { folders: [] },
      {
        clientFactory: () => {
          built = true;
          return fakeBox({}).client;
        },
      },
    );
    expect(await collect(connector.sync(ctx()))).toEqual([]);
    expect(built).toBe(false);
  });
});

/** Extractor that returns text from a table; `null` ⇒ unsupported. */
function fakeExtractor(table: Record<string, string | null>): Extractor {
  return {
    extract: (_bytes, filename) =>
      Promise.resolve(filename in table ? (table[filename] ?? null) : `extracted:${filename}`),
  };
}

describe("Box connector — end-to-end extraction through the sync service (ADR-0024)", () => {
  test("downloads an Office file and replaces the body with extracted text", async () => {
    const store = Store.open({ path: ":memory:" });
    try {
      const { client } = fakeBox(
        {
          "0": [{ files: [{ id: "42", name: "spec.docx", size: 8, sha1: "sha-1" }] }],
        },
        { "42": "DOCXBYTES" },
      );
      const connector = createBoxConnector({ folders: ["0"] }, { clientFactory: () => client });
      const out = await syncConnector(store, connector, {
        extractor: fakeExtractor({ "spec.docx": "# Spec\n\nbody" }),
        secrets: { env: { SUASOR_CONNECTOR_BOX_TOKEN: "dev-tok" } },
      });
      expect(out.extracted).toBe(1);
      const body = store.connection.sqlite
        .query<{ body: string }, [string]>("SELECT body FROM sources WHERE external_id = ?")
        .get("box:file:42")?.body;
      expect(body).toBe("spec.docx\n\n# Spec\n\nbody");
    } finally {
      store.close();
    }
  });

  test("download failure degrades to name-only (ingest still succeeds)", async () => {
    const store = Store.open({ path: ":memory:" });
    const errors: Error[] = [];
    try {
      // No download fixture for id 99 → downloadFile throws → degrade.
      const { client } = fakeBox({
        "0": [{ files: [{ id: "99", name: "broken.pdf", size: 4, sha1: "sha-x" }] }],
      });
      const connector = createBoxConnector({ folders: ["0"] }, { clientFactory: () => client });
      const out = await syncConnector(store, connector, {
        extractor: fakeExtractor({ "broken.pdf": "never used" }),
        onExtractError: (e) => errors.push(e),
        secrets: { env: { SUASOR_CONNECTOR_BOX_TOKEN: "dev-tok" } },
      });
      expect(out.observed).toBe(1);
      expect(out.extracted).toBe(0);
      expect(errors).toHaveLength(1);
      const body = store.connection.sqlite
        .query<{ body: string }, [string]>("SELECT body FROM sources WHERE external_id = ?")
        .get("box:file:99")?.body;
      expect(body).toBe("broken.pdf"); // name-only
    } finally {
      store.close();
    }
  });
});
