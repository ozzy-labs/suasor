import { describe, expect, test } from "bun:test";
import type { SourceRecord, SyncContext } from "../../src/connectors/contract.ts";
import {
  createGoogleConnector,
  type GoogleClientLike,
  GoogleConnectorConfig,
  type GooglePage,
  type GoogleResource,
} from "../../src/connectors/google.ts";
import { syncConnector } from "../../src/connectors/index.ts";
import { Store } from "../../src/db/index.ts";
import type { Extractor } from "../../src/extraction/index.ts";

function fakeGoogle(
  byResource: Partial<Record<GoogleResource, GooglePage[]>>,
  content: { downloads?: Record<string, string>; exports?: Record<string, string> } = {},
): {
  client: GoogleClientLike;
  calls: Array<{ resource: GoogleResource; pageToken?: string }>;
  downloadCalls: string[];
  exportCalls: Array<{ fileId: string; mimeType: string }>;
} {
  const calls: Array<{ resource: GoogleResource; pageToken?: string }> = [];
  const downloadCalls: string[] = [];
  const exportCalls: Array<{ fileId: string; mimeType: string }> = [];
  const cursors: Partial<Record<GoogleResource, number>> = {};
  const client: GoogleClientLike = {
    async listPage(resource, pageToken) {
      calls.push({ resource, pageToken });
      const list = byResource[resource] ?? [];
      const idx = cursors[resource] ?? 0;
      cursors[resource] = idx + 1;
      return list[idx] ?? { items: [] };
    },
    async downloadFile(fileId) {
      downloadCalls.push(fileId);
      const c = content.downloads?.[fileId];
      if (c === undefined) throw new Error(`no download fixture for ${fileId}`);
      return new TextEncoder().encode(c);
    },
    async exportFile(fileId, mimeType) {
      exportCalls.push({ fileId, mimeType });
      const c = content.exports?.[fileId];
      if (c === undefined) throw new Error(`no export fixture for ${fileId}`);
      return new TextEncoder().encode(c);
    },
  };
  return { client, calls, downloadCalls, exportCalls };
}

function ctx(overrides: Partial<SyncContext> = {}): SyncContext {
  return {
    cursor: null,
    secret: async (name) => (name === "refreshToken" ? "rt" : null),
    ...overrides,
  };
}

async function collect(it: AsyncIterable<SourceRecord>): Promise<SourceRecord[]> {
  const out: SourceRecord[] = [];
  for await (const r of it) out.push(r);
  return out;
}

describe("GoogleConnectorConfig", () => {
  test("defaults: all three resources, primary calendar", () => {
    const c = GoogleConnectorConfig.parse({});
    expect(c.resources).toEqual(["drive", "gmail", "calendar"]);
    expect(c.calendarId).toBe("primary");
  });
});

describe("Google connector — record mapping (ADR-0007 identity)", () => {
  test("maps drive/gmail/calendar to distinct source_types + resource-prefixed ids", async () => {
    const { client } = fakeGoogle({
      drive: [
        {
          items: [
            {
              id: "d1",
              title: "spec.pdf",
              detail: "design doc",
              observedAt: "2026-06-10T00:00:00Z",
            },
          ],
        },
      ],
      gmail: [
        {
          items: [
            {
              id: "g1",
              title: "Re: launch",
              detail: "snippet",
              observedAt: "2026-06-11T00:00:00Z",
            },
          ],
        },
      ],
      calendar: [
        {
          items: [
            { id: "c1", title: "Sync", detail: "weekly", observedAt: "2026-06-12T00:00:00Z" },
          ],
        },
      ],
    });
    const connector = createGoogleConnector({}, { clientFactory: () => client });
    const records = await collect(connector.sync(ctx()));
    expect(records).toHaveLength(3);

    const drive = records.find((r) => r.sourceType === "google_drive");
    expect(drive?.externalId).toBe("google:drive:d1");
    // No mimeType/size/md5/version reported → no extractable handle, no fingerprint.
    expect(drive?.extractable).toBeUndefined();
    expect(drive?.fingerprint).toBeUndefined();
    const mail = records.find((r) => r.sourceType === "gmail_message");
    expect(mail?.externalId).toBe("google:gmail:g1");
    expect(mail?.body).toBe("Re: launch\n\nsnippet");
    // Gmail/Calendar never carry an extraction handle (Drive-only, ADR-0034).
    expect(mail?.extractable).toBeUndefined();
    expect(records.find((r) => r.sourceType === "google_calendar")?.externalId).toBe(
      "google:calendar:c1",
    );
  });
});

describe("Google Drive — extraction handle + content fingerprint (ADR-0034)", () => {
  test("binary Office/PDF with size carries an extractable handle + md5 fingerprint", async () => {
    const { client, downloadCalls } = fakeGoogle(
      {
        drive: [
          {
            items: [
              {
                id: "d1",
                title: "spec.docx",
                detail: "",
                observedAt: "2026-06-10T00:00:00Z",
                mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                size: 2048,
                md5Checksum: "abc123",
                version: "7",
              },
            ],
          },
        ],
      },
      { downloads: { d1: "DOCX-BYTES" } },
    );
    const connector = createGoogleConnector(
      { resources: ["drive"] },
      { clientFactory: () => client },
    );
    const records = await collect(connector.sync(ctx()));
    // md5Checksum (content hash) drives delta detection (ADR-0034 §b).
    expect(records[0]?.fingerprint).toBe("abc123");
    expect(records[0]?.extractable?.filename).toBe("spec.docx");
    expect(records[0]?.extractable?.byteSize).toBe(2048);
    // readBytes is lazy: not called until the sync extraction stage drives it.
    expect(downloadCalls).toEqual([]);
    const bytes = await records[0]?.extractable?.readBytes();
    expect(new TextDecoder().decode(bytes)).toBe("DOCX-BYTES");
    expect(downloadCalls).toEqual(["d1"]);
  });

  test("Google-native doc exports to docx; filename gets the .docx extension; version fingerprints", async () => {
    const { client, exportCalls } = fakeGoogle(
      {
        drive: [
          {
            items: [
              {
                id: "n1",
                title: "Design notes",
                detail: "",
                observedAt: "2026-06-10T00:00:00Z",
                mimeType: "application/vnd.google-apps.document",
                version: "12",
              },
            ],
          },
        ],
      },
      { exports: { n1: "EXPORTED-DOCX" } },
    );
    const connector = createGoogleConnector(
      { resources: ["drive"] },
      { clientFactory: () => client },
    );
    const records = await collect(connector.sync(ctx()));
    // Native files have no md5 → version is the fingerprint (ADR-0034 §b).
    expect(records[0]?.fingerprint).toBe("12");
    // Synthetic filename carries the export extension so the sidecar dispatches docx.
    expect(records[0]?.extractable?.filename).toBe("Design notes.docx");
    expect(exportCalls).toEqual([]); // lazy
    const bytes = await records[0]?.extractable?.readBytes();
    expect(new TextDecoder().decode(bytes)).toBe("EXPORTED-DOCX");
    expect(exportCalls).toEqual([
      {
        fileId: "n1",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
    ]);
  });

  test("native sheet → xlsx and native slides → pptx export targets", async () => {
    const { client } = fakeGoogle({
      drive: [
        {
          items: [
            {
              id: "s1",
              title: "Budget",
              detail: "",
              observedAt: "2026-06-10T00:00:00Z",
              mimeType: "application/vnd.google-apps.spreadsheet",
              version: "3",
            },
            {
              id: "p1",
              title: "Deck",
              detail: "",
              observedAt: "2026-06-10T00:00:00Z",
              mimeType: "application/vnd.google-apps.presentation",
              version: "4",
            },
          ],
        },
      ],
    });
    const connector = createGoogleConnector(
      { resources: ["drive"] },
      { clientFactory: () => client },
    );
    const records = await collect(connector.sync(ctx()));
    expect(records.find((r) => r.externalId === "google:drive:s1")?.extractable?.filename).toBe(
      "Budget.xlsx",
    );
    expect(records.find((r) => r.externalId === "google:drive:p1")?.extractable?.filename).toBe(
      "Deck.pptx",
    );
  });

  test("unmapped native type (e.g. Forms) → no extractable handle (still fingerprinted)", async () => {
    const { client } = fakeGoogle({
      drive: [
        {
          items: [
            {
              id: "f1",
              title: "Survey",
              detail: "",
              observedAt: "2026-06-10T00:00:00Z",
              mimeType: "application/vnd.google-apps.form",
              version: "2",
            },
          ],
        },
      ],
    });
    const connector = createGoogleConnector(
      { resources: ["drive"] },
      { clientFactory: () => client },
    );
    const records = await collect(connector.sync(ctx()));
    expect(records[0]?.extractable).toBeUndefined();
    expect(records[0]?.fingerprint).toBe("2");
  });

  test("non-extractable binary extension gets no handle (md5 still fingerprints)", async () => {
    const { client } = fakeGoogle({
      drive: [
        {
          items: [
            {
              id: "img1",
              title: "photo.png",
              detail: "",
              observedAt: "2026-06-10T00:00:00Z",
              mimeType: "image/png",
              size: 100,
              md5Checksum: "deadbeef",
            },
          ],
        },
      ],
    });
    const connector = createGoogleConnector(
      { resources: ["drive"] },
      { clientFactory: () => client },
    );
    const records = await collect(connector.sync(ctx()));
    expect(records[0]?.extractable).toBeUndefined();
    expect(records[0]?.fingerprint).toBe("deadbeef");
  });

  test("extractable binary extension but missing size → no handle (cannot size-guard)", async () => {
    const { client } = fakeGoogle({
      drive: [
        {
          items: [
            {
              id: "u1",
              title: "untracked.pdf",
              detail: "",
              observedAt: "2026-06-10T00:00:00Z",
              mimeType: "application/pdf",
              md5Checksum: "ff00",
            },
          ],
        },
      ],
    });
    const connector = createGoogleConnector(
      { resources: ["drive"] },
      { clientFactory: () => client },
    );
    const records = await collect(connector.sync(ctx()));
    expect(records[0]?.extractable).toBeUndefined();
    expect(records[0]?.fingerprint).toBe("ff00");
  });
});

describe("Google connector — pagination + fingerprint cursor", () => {
  test("follows nextPageToken and returns null cursor", async () => {
    const { client, calls } = fakeGoogle({
      drive: [
        {
          items: [{ id: "d1", title: "a", detail: "", observedAt: "2026-06-10T00:00:00Z" }],
          nextPageToken: "p2",
        },
        { items: [{ id: "d2", title: "b", detail: "", observedAt: "2026-06-10T00:00:00Z" }] },
      ],
    });
    const connector = createGoogleConnector(
      { resources: ["drive"] },
      { clientFactory: () => client },
    );
    const records = await collect(connector.sync(ctx()));
    expect(records).toHaveLength(2);
    expect(calls[1]?.pageToken).toBe("p2");
    expect((await connector.finalize?.())?.cursor).toBeNull();
  });
});

/** A fake whose `listPage` throws for resources named in `failResources`. */
function fakeFailingGoogle(opts: {
  byResource: Partial<Record<GoogleResource, GooglePage[]>>;
  failResources: Partial<Record<GoogleResource, Error>>;
}): GoogleClientLike {
  const cursors: Partial<Record<GoogleResource, number>> = {};
  return {
    async listPage(resource, _pageToken) {
      if (opts.failResources[resource]) throw opts.failResources[resource];
      const list = opts.byResource[resource] ?? [];
      const idx = cursors[resource] ?? 0;
      cursors[resource] = idx + 1;
      return list[idx] ?? { items: [] };
    },
    async downloadFile() {
      return new Uint8Array(0);
    },
    async exportFile() {
      return new Uint8Array(0);
    },
  };
}

const driveItem = { id: "d1", title: "a", detail: "", observedAt: "2026-06-10T00:00:00Z" };
const calItem = { id: "c1", title: "c", detail: "", observedAt: "2026-06-12T00:00:00Z" };

describe("Google connector — per-resource error isolation (Issue #193)", () => {
  test("one resource family failing is skipped; the rest stream; one aggregated warn", async () => {
    const client = fakeFailingGoogle({
      byResource: { drive: [{ items: [driveItem] }], calendar: [{ items: [calItem] }] },
      failResources: { gmail: new Error("403 Forbidden") },
    });
    const warns: string[] = [];
    const connector = createGoogleConnector(
      { resources: ["drive", "gmail", "calendar"] },
      { clientFactory: () => client },
    );
    const records = await collect(connector.sync(ctx({ onWarn: (m) => warns.push(m) })));
    expect(records.map((r) => r.sourceType).sort()).toEqual(["google_calendar", "google_drive"]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("2 resource OK, 1 failed (cursor preserved)");
    expect(warns[0]).toContain("gmail (403 Forbidden)");
  });

  test("partial failure sets partialFailure + a summary line in finalize", async () => {
    const client = fakeFailingGoogle({
      byResource: { drive: [{ items: [driveItem] }] },
      failResources: { gmail: new Error("boom") },
    });
    const connector = createGoogleConnector(
      { resources: ["drive", "gmail"] },
      { clientFactory: () => client },
    );
    await collect(connector.sync(ctx({ onWarn: () => {} })));
    const result = await connector.finalize?.();
    expect(result?.cursor).toBeNull();
    expect(result?.partialFailure).toBe(true);
    expect(result?.summaryLines?.[0]).toBe("resources: drive=ok, gmail=failed (cursor preserved)");
  });

  test("all resources failing throws", async () => {
    const client = fakeFailingGoogle({
      byResource: {},
      failResources: { drive: new Error("403"), gmail: new Error("404") },
    });
    const connector = createGoogleConnector(
      { resources: ["drive", "gmail"] },
      { clientFactory: () => client },
    );
    await expect(collect(connector.sync(ctx({ onWarn: () => {} })))).rejects.toThrow(/40[34]/);
  });

  test("a clean run sets no partialFailure", async () => {
    const client = fakeFailingGoogle({
      byResource: { drive: [{ items: [driveItem] }] },
      failResources: {},
    });
    const connector = createGoogleConnector(
      { resources: ["drive"] },
      { clientFactory: () => client },
    );
    await collect(connector.sync(ctx()));
    const result = await connector.finalize?.();
    expect(result?.partialFailure).toBeUndefined();
  });
});

describe("Google connector — guards", () => {
  test("throws when no refreshToken is configured", async () => {
    const connector = createGoogleConnector(
      { resources: ["drive"] },
      { clientFactory: () => fakeGoogle({}).client },
    );
    await expect(collect(connector.sync(ctx({ secret: async () => null })))).rejects.toThrow(
      /no refreshToken configured/,
    );
  });

  test("no resources yields nothing (and never builds a client)", async () => {
    let built = false;
    const connector = createGoogleConnector(
      { resources: [] },
      {
        clientFactory: () => {
          built = true;
          return fakeGoogle({}).client;
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

describe("Google Drive — end-to-end extraction through the sync service (ADR-0034)", () => {
  test("downloads a binary Office file and replaces the body with extracted text", async () => {
    const store = Store.open({ path: ":memory:" });
    try {
      const { client } = fakeGoogle(
        {
          drive: [
            {
              items: [
                {
                  id: "d1",
                  title: "spec.docx",
                  detail: "",
                  observedAt: "2026-06-10T00:00:00Z",
                  mimeType:
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                  size: 8,
                  md5Checksum: "md5-1",
                },
              ],
            },
          ],
        },
        { downloads: { d1: "DOCXBYTES" } },
      );
      const connector = createGoogleConnector(
        { resources: ["drive"] },
        { clientFactory: () => client },
      );
      const out = await syncConnector(store, connector, {
        extractor: fakeExtractor({ "spec.docx": "# Spec\n\nbody" }),
        secrets: { env: { SUASOR_CONNECTOR_GOOGLE_REFRESHTOKEN: "rt" } },
      });
      expect(out.extracted).toBe(1);
      const body = store.connection.sqlite
        .query<{ body: string }, [string]>("SELECT body FROM sources WHERE external_id = ?")
        .get("google:drive:d1")?.body;
      expect(body).toBe("spec.docx\n\n# Spec\n\nbody");
    } finally {
      store.close();
    }
  });

  test("exports a Google-native doc and extracts the exported docx", async () => {
    const store = Store.open({ path: ":memory:" });
    try {
      const { client, exportCalls } = fakeGoogle(
        {
          drive: [
            {
              items: [
                {
                  id: "n1",
                  title: "Roadmap",
                  detail: "",
                  observedAt: "2026-06-10T00:00:00Z",
                  mimeType: "application/vnd.google-apps.document",
                  version: "5",
                },
              ],
            },
          ],
        },
        { exports: { n1: "EXPORTED" } },
      );
      const connector = createGoogleConnector(
        { resources: ["drive"] },
        { clientFactory: () => client },
      );
      const out = await syncConnector(store, connector, {
        // Sidecar dispatches on the synthetic `Roadmap.docx` filename.
        extractor: fakeExtractor({ "Roadmap.docx": "# Roadmap\n\nQ3 plan" }),
        secrets: { env: { SUASOR_CONNECTOR_GOOGLE_REFRESHTOKEN: "rt" } },
      });
      expect(out.extracted).toBe(1);
      expect(exportCalls[0]?.mimeType).toBe(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      );
      const body = store.connection.sqlite
        .query<{ body: string }, [string]>("SELECT body FROM sources WHERE external_id = ?")
        .get("google:drive:n1")?.body;
      expect(body).toBe("Roadmap.docx\n\n# Roadmap\n\nQ3 plan");
    } finally {
      store.close();
    }
  });

  test("download failure degrades to name-only (ingest still succeeds)", async () => {
    const store = Store.open({ path: ":memory:" });
    const errors: Error[] = [];
    try {
      // No download fixture for id 99 → downloadFile throws → degrade.
      const { client } = fakeGoogle({
        drive: [
          {
            items: [
              {
                id: "99",
                title: "broken.pdf",
                detail: "",
                observedAt: "2026-06-10T00:00:00Z",
                mimeType: "application/pdf",
                size: 4,
                md5Checksum: "md5-x",
              },
            ],
          },
        ],
      });
      const connector = createGoogleConnector(
        { resources: ["drive"] },
        { clientFactory: () => client },
      );
      const out = await syncConnector(store, connector, {
        extractor: fakeExtractor({ "broken.pdf": "never used" }),
        onExtractError: (e) => errors.push(e),
        secrets: { env: { SUASOR_CONNECTOR_GOOGLE_REFRESHTOKEN: "rt" } },
      });
      expect(out.observed).toBe(1);
      expect(out.extracted).toBe(0);
      expect(errors).toHaveLength(1);
      const body = store.connection.sqlite
        .query<{ body: string }, [string]>("SELECT body FROM sources WHERE external_id = ?")
        .get("google:drive:99")?.body;
      expect(body).toBe("broken.pdf"); // name-only
    } finally {
      store.close();
    }
  });
});
