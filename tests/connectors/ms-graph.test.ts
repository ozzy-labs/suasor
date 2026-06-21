import { describe, expect, test } from "bun:test";
import type { SourceRecord, SyncContext } from "../../src/connectors/contract.ts";
import { syncConnector } from "../../src/connectors/index.ts";
import {
  createMsGraphConnector,
  type MsGraphClientLike,
  MsGraphConnectorConfig,
} from "../../src/connectors/ms-graph.ts";
import { Store } from "../../src/db/index.ts";
import type { Extractor } from "../../src/extraction/index.ts";

type Page = {
  value: Array<{ id: string; [k: string]: unknown }>;
  "@odata.nextLink"?: string;
};

function fakeGraph(
  pagesByPath: Record<string, Page[]>,
  downloads: Record<string, string> = {},
): {
  client: MsGraphClientLike;
  paths: string[];
  downloadCalls: string[];
} {
  const paths: string[] = [];
  const downloadCalls: string[] = [];
  const cursors: Record<string, number> = {};
  const client: MsGraphClientLike = {
    async getPage(path) {
      paths.push(path);
      // Each path (including synthetic `next:<bucket>` links) maps 1:1 to a
      // configured page list; unknown paths return an empty page.
      const list = pagesByPath[path] ?? [];
      const idx = cursors[path] ?? 0;
      cursors[path] = idx + 1;
      return list[idx] ?? { value: [] };
    },
    async downloadFile(itemId) {
      downloadCalls.push(itemId);
      const content = downloads[itemId];
      if (content === undefined) throw new Error(`no download fixture for ${itemId}`);
      return new TextEncoder().encode(content);
    },
  };
  return { client, paths, downloadCalls };
}

function ctx(overrides: Partial<SyncContext> = {}): SyncContext {
  return {
    cursor: null,
    secret: async (name) => (name === "clientSecret" ? "secret" : null),
    ...overrides,
  };
}

async function collect(it: AsyncIterable<SourceRecord>): Promise<SourceRecord[]> {
  const out: SourceRecord[] = [];
  for await (const r of it) out.push(r);
  return out;
}

const baseConfig = { tenantId: "tid", clientId: "cid", user: "me" };

describe("MsGraphConnectorConfig", () => {
  test("defaults resources to mail + calendar", () => {
    const c = MsGraphConnectorConfig.parse({});
    expect(c.resources).toEqual(["mail", "calendar"]);
    expect(c.user).toBe("me");
  });
});

describe("MS Graph connector — record mapping (ADR-0007 identity)", () => {
  test("maps mail and calendar to distinct source_types + resource-prefixed ids", async () => {
    const { client } = fakeGraph({
      "/users/me/messages?$top=50&$select=id,subject,bodyPreview,receivedDateTime": [
        {
          value: [
            {
              id: "m1",
              subject: "Hi",
              bodyPreview: "preview",
              receivedDateTime: "2026-06-10T00:00:00Z",
            },
          ],
        },
      ],
      "/users/me/events?$top=50&$select=id,subject,bodyPreview,start": [
        {
          value: [
            {
              id: "e1",
              subject: "Standup",
              bodyPreview: "agenda",
              start: { dateTime: "2026-06-11T09:00:00Z" },
            },
          ],
        },
      ],
    });
    const connector = createMsGraphConnector(baseConfig, { clientFactory: () => client });
    const records = await collect(connector.sync(ctx()));
    expect(records).toHaveLength(2);

    const mail = records.find((r) => r.sourceType === "ms365_mail");
    expect(mail?.externalId).toBe("msgraph:mail:m1");
    expect(mail?.body).toBe("Hi\n\npreview");
    expect(mail?.observedAt).toBe("2026-06-10T00:00:00Z");

    const cal = records.find((r) => r.sourceType === "ms365_calendar");
    expect(cal?.externalId).toBe("msgraph:calendar:e1");
    expect(cal?.observedAt).toBe("2026-06-11T09:00:00Z");
  });

  test("files and teams resources produce ms365_file / ms365_teams_message", async () => {
    const { client } = fakeGraph({
      "/users/me/drive/root/children?$top=50&$select=id,name,lastModifiedDateTime,size,file": [
        // No `size`/`file` reported → name-only (no extractable handle, no fingerprint).
        { value: [{ id: "f1", name: "doc.docx", lastModifiedDateTime: "2026-06-12T00:00:00Z" }] },
      ],
      "/users/me/chats/getAllMessages?$top=50": [
        {
          value: [
            { id: "t1", body: { content: "team msg" }, createdDateTime: "2026-06-13T00:00:00Z" },
          ],
        },
      ],
    });
    const connector = createMsGraphConnector(
      { ...baseConfig, resources: ["files", "teams"] },
      { clientFactory: () => client },
    );
    const records = await collect(connector.sync(ctx()));
    const file = records.find((r) => r.sourceType === "ms365_file");
    expect(file?.externalId).toBe("msgraph:files:f1");
    expect(file?.extractable).toBeUndefined();
    expect(file?.fingerprint).toBeUndefined();
    expect(records.find((r) => r.sourceType === "ms365_teams_message")?.externalId).toBe(
      "msgraph:teams:t1",
    );
  });
});

const FILES_PATH =
  "/users/me/drive/root/children?$top=50&$select=id,name,lastModifiedDateTime,size,file";

describe("MS Graph connector — OneDrive extraction handle + content fingerprint (ADR-0024)", () => {
  test("Office/PDF file with size carries an extractable handle and content-hash fingerprint", async () => {
    const { client, downloadCalls } = fakeGraph(
      {
        [FILES_PATH]: [
          {
            value: [
              {
                id: "f42",
                name: "spec.docx",
                lastModifiedDateTime: "2026-06-12T00:00:00Z",
                size: 2048,
                file: { hashes: { quickXorHash: "QXH123" } },
              },
            ],
          },
        ],
      },
      { f42: "DOCX-BYTES" },
    );
    const connector = createMsGraphConnector(
      { ...baseConfig, resources: ["files"] },
      { clientFactory: () => client },
    );
    const records = await collect(connector.sync(ctx()));
    expect(records).toHaveLength(1);
    // quickXorHash drives delta detection (content change re-extracts, ADR-0024 §6).
    expect(records[0]?.fingerprint).toBe("QXH123");
    expect(records[0]?.extractable?.filename).toBe("spec.docx");
    expect(records[0]?.extractable?.byteSize).toBe(2048);
    // readBytes is lazy: not called until the sync extraction stage drives it.
    expect(downloadCalls).toEqual([]);
    const bytes = await records[0]?.extractable?.readBytes();
    expect(new TextDecoder().decode(bytes)).toBe("DOCX-BYTES");
    expect(downloadCalls).toEqual(["f42"]);
  });

  test("hash preference: quickXorHash > sha256 > sha1", async () => {
    const { client } = fakeGraph({
      [FILES_PATH]: [
        {
          value: [
            {
              id: "a",
              name: "a.docx",
              size: 1,
              file: { hashes: { sha256Hash: "S256", sha1Hash: "S1" } },
            },
            { id: "b", name: "b.docx", size: 1, file: { hashes: { sha1Hash: "S1only" } } },
          ],
        },
      ],
    });
    const connector = createMsGraphConnector(
      { ...baseConfig, resources: ["files"] },
      { clientFactory: () => client },
    );
    const records = await collect(connector.sync(ctx()));
    expect(records.find((r) => r.externalId === "msgraph:files:a")?.fingerprint).toBe("S256");
    expect(records.find((r) => r.externalId === "msgraph:files:b")?.fingerprint).toBe("S1only");
  });

  test("non-extractable extension gets no handle (content hash still fingerprints)", async () => {
    const { client } = fakeGraph({
      [FILES_PATH]: [
        {
          value: [
            { id: "p", name: "photo.png", size: 100, file: { hashes: { quickXorHash: "PNGH" } } },
          ],
        },
      ],
    });
    const connector = createMsGraphConnector(
      { ...baseConfig, resources: ["files"] },
      { clientFactory: () => client },
    );
    const records = await collect(connector.sync(ctx()));
    expect(records[0]?.extractable).toBeUndefined();
    expect(records[0]?.fingerprint).toBe("PNGH");
  });

  test("extractable extension but missing size → no handle (cannot size-guard)", async () => {
    const { client } = fakeGraph({
      [FILES_PATH]: [
        { value: [{ id: "d", name: "deck.pptx", file: { hashes: { quickXorHash: "PPTX" } } }] },
      ],
    });
    const connector = createMsGraphConnector(
      { ...baseConfig, resources: ["files"] },
      { clientFactory: () => client },
    );
    const records = await collect(connector.sync(ctx()));
    expect(records[0]?.extractable).toBeUndefined();
    expect(records[0]?.fingerprint).toBe("PPTX");
  });

  test("non-files resources never carry an extractable handle or content fingerprint", async () => {
    const { client } = fakeGraph({
      "/users/me/messages?$top=50&$select=id,subject,bodyPreview,receivedDateTime": [
        { value: [{ id: "m1", subject: "report.docx", size: 99 }] },
      ],
    });
    const connector = createMsGraphConnector(
      { ...baseConfig, resources: ["mail"] },
      { clientFactory: () => client },
    );
    const records = await collect(connector.sync(ctx()));
    expect(records[0]?.extractable).toBeUndefined();
    expect(records[0]?.fingerprint).toBeUndefined();
  });
});

/** Extractor that returns text from a table; `null` ⇒ unsupported. */
function fakeExtractor(table: Record<string, string | null>): Extractor {
  return {
    extract: (_bytes, filename) =>
      Promise.resolve(filename in table ? (table[filename] ?? null) : `extracted:${filename}`),
  };
}

describe("MS Graph connector — end-to-end OneDrive extraction through the sync service (ADR-0024)", () => {
  test("downloads an Office file and replaces the body with extracted text", async () => {
    const store = Store.open({ path: ":memory:" });
    try {
      const { client } = fakeGraph(
        {
          [FILES_PATH]: [
            {
              value: [
                { id: "f42", name: "spec.docx", size: 8, file: { hashes: { quickXorHash: "h1" } } },
              ],
            },
          ],
        },
        { f42: "DOCXBYTES" },
      );
      const connector = createMsGraphConnector(
        { ...baseConfig, resources: ["files"] },
        { clientFactory: () => client },
      );
      const out = await syncConnector(store, connector, {
        extractor: fakeExtractor({ "spec.docx": "# Spec\n\nbody" }),
        secrets: { env: { SUASOR_CONNECTOR_MS_GRAPH_CLIENTSECRET: "sec" } },
      });
      expect(out.extracted).toBe(1);
      const body = store.connection.sqlite
        .query<{ body: string }, [string]>("SELECT body FROM sources WHERE external_id = ?")
        .get("msgraph:files:f42")?.body;
      expect(body).toBe("spec.docx\n\n# Spec\n\nbody");
    } finally {
      store.close();
    }
  });

  test("download failure degrades to name-only (ingest still succeeds)", async () => {
    const store = Store.open({ path: ":memory:" });
    const errors: Error[] = [];
    try {
      // No download fixture for id f99 → downloadFile throws → degrade.
      const { client } = fakeGraph({
        [FILES_PATH]: [
          {
            value: [
              { id: "f99", name: "broken.pdf", size: 4, file: { hashes: { quickXorHash: "hx" } } },
            ],
          },
        ],
      });
      const connector = createMsGraphConnector(
        { ...baseConfig, resources: ["files"] },
        { clientFactory: () => client },
      );
      const out = await syncConnector(store, connector, {
        extractor: fakeExtractor({ "broken.pdf": "never used" }),
        onExtractError: (e) => errors.push(e),
        secrets: { env: { SUASOR_CONNECTOR_MS_GRAPH_CLIENTSECRET: "sec" } },
      });
      expect(out.observed).toBe(1);
      expect(out.extracted).toBe(0);
      expect(errors).toHaveLength(1);
      const body = store.connection.sqlite
        .query<{ body: string }, [string]>("SELECT body FROM sources WHERE external_id = ?")
        .get("msgraph:files:f99")?.body;
      expect(body).toBe("broken.pdf"); // name-only
    } finally {
      store.close();
    }
  });

  test("content-hash change (same filename) is detected as a body update (ADR-0024 §6)", async () => {
    const store = Store.open({ path: ":memory:" });
    try {
      const mk = (hash: string) =>
        createMsGraphConnector(
          { ...baseConfig, resources: ["files"] },
          {
            clientFactory: () => ({
              getPage: async (path) =>
                path === FILES_PATH
                  ? {
                      value: [
                        {
                          id: "f1",
                          name: "plan.docx",
                          size: 4,
                          file: { hashes: { quickXorHash: hash } },
                        },
                      ],
                    }
                  : { value: [] },
              downloadFile: async () => new Uint8Array(0),
            }),
          },
        );
      const run = (hash: string) =>
        syncConnector(store, mk(hash), {
          secrets: { env: { SUASOR_CONNECTOR_MS_GRAPH_CLIENTSECRET: "sec" } },
        });
      const out1 = await run("v1");
      expect(out1.observed).toBe(1);
      // Same filename, new content hash → fingerprint differs → update.
      const out2 = await run("v2");
      expect(out2.updated).toBe(1);
      expect(out2.unchanged).toBe(0);
    } finally {
      store.close();
    }
  });
});

describe("MS Graph connector — pagination + fingerprint cursor", () => {
  test("follows @odata.nextLink and returns null cursor", async () => {
    const { client, paths } = fakeGraph({
      "/users/me/messages?$top=50&$select=id,subject,bodyPreview,receivedDateTime": [
        { value: [{ id: "m1", subject: "a" }], "@odata.nextLink": "next:bucket" },
      ],
      "next:bucket": [{ value: [{ id: "m2", subject: "b" }] }],
    });
    const connector = createMsGraphConnector(
      { ...baseConfig, resources: ["mail"] },
      { clientFactory: () => client },
    );
    const records = await collect(connector.sync(ctx()));
    expect(records).toHaveLength(2);
    expect(paths).toContain("next:bucket");
    expect((await connector.finalize?.())?.cursor).toBeNull();
  });
});

/**
 * A fake keyed by a path *substring* so a whole resource family can be made to
 * fail (its first list path contains a stable token like `/messages` or
 * `/events`). `failPaths` maps such a token to the error to throw.
 */
function fakeFailingGraph(opts: {
  pagesByPath: Record<string, Page[]>;
  failPaths: Record<string, Error>;
}): MsGraphClientLike {
  const cursors: Record<string, number> = {};
  return {
    async getPage(path) {
      for (const [token, error] of Object.entries(opts.failPaths)) {
        if (path.includes(token)) throw error;
      }
      const list = opts.pagesByPath[path] ?? [];
      const idx = cursors[path] ?? 0;
      cursors[path] = idx + 1;
      return list[idx] ?? { value: [] };
    },
    async downloadFile() {
      return new Uint8Array(0);
    },
  };
}

describe("MS Graph connector — per-resource error isolation (Issue #193)", () => {
  test("one resource family failing is skipped; the rest stream; one aggregated warn", async () => {
    const client = fakeFailingGraph({
      pagesByPath: {
        "/users/me/events?$top=50&$select=id,subject,bodyPreview,start": [
          {
            value: [{ id: "e1", subject: "Standup", start: { dateTime: "2026-06-11T00:00:00Z" } }],
          },
        ],
      },
      failPaths: { "/messages": new Error("403 Forbidden") },
    });
    const warns: string[] = [];
    const connector = createMsGraphConnector(
      { ...baseConfig, resources: ["mail", "calendar"] },
      { clientFactory: () => client },
    );
    const records = await collect(connector.sync(ctx({ onWarn: (m) => warns.push(m) })));
    expect(records.map((r) => r.sourceType)).toEqual(["ms365_calendar"]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("1 resource OK, 1 failed (cursor preserved)");
    expect(warns[0]).toContain("mail (403 Forbidden)");
  });

  test("partial failure sets partialFailure + a summary line in finalize", async () => {
    const client = fakeFailingGraph({
      pagesByPath: {
        "/users/me/events?$top=50&$select=id,subject,bodyPreview,start": [
          { value: [{ id: "e1", subject: "Standup" }] },
        ],
      },
      failPaths: { "/messages": new Error("boom") },
    });
    const connector = createMsGraphConnector(
      { ...baseConfig, resources: ["mail", "calendar"] },
      { clientFactory: () => client },
    );
    await collect(connector.sync(ctx({ onWarn: () => {} })));
    const result = await connector.finalize?.();
    expect(result?.cursor).toBeNull();
    expect(result?.partialFailure).toBe(true);
    expect(result?.summaryLines?.[0]).toBe(
      "resources: mail=failed (cursor preserved), calendar=ok",
    );
  });

  test("all resources failing throws", async () => {
    const client = fakeFailingGraph({
      pagesByPath: {},
      failPaths: { "/messages": new Error("403"), "/events": new Error("404") },
    });
    const connector = createMsGraphConnector(
      { ...baseConfig, resources: ["mail", "calendar"] },
      { clientFactory: () => client },
    );
    await expect(collect(connector.sync(ctx({ onWarn: () => {} })))).rejects.toThrow(/40[34]/);
  });

  test("a clean run sets no partialFailure", async () => {
    const client = fakeFailingGraph({
      pagesByPath: {
        "/users/me/messages?$top=50&$select=id,subject,bodyPreview,receivedDateTime": [
          { value: [{ id: "m1", subject: "a" }] },
        ],
      },
      failPaths: {},
    });
    const connector = createMsGraphConnector(
      { ...baseConfig, resources: ["mail"] },
      { clientFactory: () => client },
    );
    await collect(connector.sync(ctx()));
    const result = await connector.finalize?.();
    expect(result?.partialFailure).toBeUndefined();
  });
});

describe("MS Graph connector — guards", () => {
  test("throws when no clientSecret is configured", async () => {
    const connector = createMsGraphConnector(baseConfig, {
      clientFactory: () => fakeGraph({}).client,
    });
    await expect(collect(connector.sync(ctx({ secret: async () => null })))).rejects.toThrow(
      /no clientSecret configured/,
    );
  });

  test("throws when tenantId/clientId missing", async () => {
    const connector = createMsGraphConnector(
      { resources: ["mail"] },
      { clientFactory: () => fakeGraph({}).client },
    );
    await expect(collect(connector.sync(ctx()))).rejects.toThrow(/tenantId and clientId/);
  });

  test("no resources yields nothing (and never builds a client)", async () => {
    let built = false;
    const connector = createMsGraphConnector(
      { ...baseConfig, resources: [] },
      {
        clientFactory: () => {
          built = true;
          return fakeGraph({}).client;
        },
      },
    );
    expect(await collect(connector.sync(ctx()))).toEqual([]);
    expect(built).toBe(false);
  });
});
