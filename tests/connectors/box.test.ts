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
  test("maps files to box_file with file-prefixed ids and sha1 fingerprint", async () => {
    const { client } = fakeBox({
      "0": [
        {
          files: [
            { id: "11", name: "report.pdf", modifiedAt: "2026-06-10T00:00:00Z", sha1: "abc123" },
          ],
        },
      ],
    });
    const connector = createBoxConnector({ folders: ["0"] }, { clientFactory: () => client });
    const records = await collect(connector.sync(ctx()));
    expect(records).toHaveLength(1);
    expect(records[0]?.externalId).toBe("box:file:11");
    expect(records[0]?.sourceType).toBe("box_file");
    expect(records[0]?.body).toBe("report.pdf");
    expect(records[0]?.fingerprint).toBe("abc123");
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
