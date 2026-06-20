import { describe, expect, test } from "bun:test";
import {
  type BoxClientLike,
  BoxConnectorConfig,
  type BoxPage,
  createBoxConnector,
} from "../../src/connectors/box.ts";
import type { SourceRecord, SyncContext } from "../../src/connectors/contract.ts";

function fakeBox(pagesByFolder: Record<string, BoxPage[]>): {
  client: BoxClientLike;
  calls: Array<{ folderId: string; marker?: string }>;
} {
  const calls: Array<{ folderId: string; marker?: string }> = [];
  const cursors: Record<string, number> = {};
  const client: BoxClientLike = {
    async listFolder(folderId, marker) {
      calls.push({ folderId, marker });
      const list = pagesByFolder[folderId] ?? [];
      const idx = cursors[folderId] ?? 0;
      cursors[folderId] = idx + 1;
      return list[idx] ?? { files: [] };
    },
  };
  return { client, calls };
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
  test("maps files to box_file with file-prefixed ids; body is filename-only, no fingerprint override", async () => {
    const { client } = fakeBox({
      "0": [
        {
          files: [{ id: "11", name: "report.pdf", modifiedAt: "2026-06-10T00:00:00Z" }],
        },
      ],
    });
    const connector = createBoxConnector({ folders: ["0"] }, { clientFactory: () => client });
    const records = await collect(connector.sync(ctx()));
    expect(records).toHaveLength(1);
    expect(records[0]?.externalId).toBe("box:file:11");
    expect(records[0]?.sourceType).toBe("box_file");
    expect(records[0]?.body).toBe("report.pdf");
    // No connector-supplied fingerprint: delta detection keys off the body
    // SHA-256 (sync service default) so body + fingerprint track the same
    // content — the filename (issue #36).
    expect(records[0]?.fingerprint).toBeUndefined();
    expect(records[0]?.observedAt).toBe("2026-06-10T00:00:00Z");
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
