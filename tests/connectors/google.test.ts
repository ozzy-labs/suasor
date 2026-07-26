import { describe, expect, test } from "bun:test";
import type { SourceRecord, SyncContext } from "../../src/connectors/contract.ts";
import {
  createGoogleConnector,
  type GoogleClientLike,
  GoogleConnectorConfig,
  type GooglePage,
  type GoogleResource,
  manifest,
  rejectLegacyGoogleConfig,
} from "../../src/connectors/google.ts";
import { syncConnector } from "../../src/connectors/index.ts";
import { Store } from "../../src/db/index.ts";
import type { Extractor } from "../../src/extraction/index.ts";

function fakeGoogle(
  byResource: Partial<Record<GoogleResource, GooglePage[]>>,
  content: { downloads?: Record<string, string>; exports?: Record<string, string> } = {},
): {
  client: GoogleClientLike;
  calls: Array<{ resource: GoogleResource; pageToken?: string; calendarId?: string }>;
  downloadCalls: string[];
  exportCalls: Array<{ fileId: string; mimeType: string }>;
} {
  const calls: Array<{ resource: GoogleResource; pageToken?: string; calendarId?: string }> = [];
  const downloadCalls: string[] = [];
  const exportCalls: Array<{ fileId: string; mimeType: string }> = [];
  const cursors: Record<string, number> = {};
  const client: GoogleClientLike = {
    async listPage(resource, pageToken, calendarId) {
      calls.push({ resource, pageToken, calendarId });
      // Calendar fixtures are keyed per calendar so a multi-calendar walk can
      // return different events per id (ADR-0051); other families ignore it.
      const key = calendarId === undefined ? resource : `${resource}:${calendarId}`;
      const list = byResource[resource] ?? [];
      const idx = cursors[key] ?? 0;
      cursors[key] = idx + 1;
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
  test("defaults: all three resources, the primary calendar as a one-entry list", () => {
    const c = GoogleConnectorConfig.parse({});
    expect(c.resources).toEqual(["drive", "gmail", "calendar"]);
    expect(c.calendarIds).toEqual(["primary"]);
  });

  test("accepts several calendars", () => {
    const c = GoogleConnectorConfig.parse({ calendarIds: ["primary", "team@group.calendar"] });
    expect(c.calendarIds).toEqual(["primary", "team@group.calendar"]);
  });
});

describe("rejectLegacyGoogleConfig (ADR-0051)", () => {
  test("names the flat calendarId and the calendarIds line that replaces it", () => {
    try {
      rejectLegacyGoogleConfig({ calendarId: "work@example.com" });
      throw new Error("expected a throw");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("calendarId");
      expect(message).toContain('calendarIds = ["work@example.com"]');
      expect(message).toContain("[connectors.google]");
    }
  });

  test("reaches inside per-account tables and points at the account's own section", () => {
    try {
      rejectLegacyGoogleConfig({ accounts: { work: { calendarId: "w@x" } } });
      throw new Error("expected a throw");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("[connectors.google.accounts.work]");
      expect(message).toContain('calendarIds = ["w@x"]');
    }
  });

  test("a migrated config passes", () => {
    expect(() =>
      rejectLegacyGoogleConfig({ calendarIds: ["primary"], accounts: { work: {} } }),
    ).not.toThrow();
    expect(() => rejectLegacyGoogleConfig({})).not.toThrow();
  });

  test("the connector refuses to build on the legacy key (no silent promotion)", () => {
    expect(() => createGoogleConnector({ calendarId: "primary" })).toThrow("calendarIds");
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

describe("Google connector — multiple calendars (ADR-0051)", () => {
  test("one configured calendar keeps the pre-ADR-0051 id, meta and label", async () => {
    // The compatibility hinge: an existing install's ingested calendar lineage
    // has to survive the key rename, so a single-calendar config must produce a
    // byte-identical record.
    const { client, calls } = fakeGoogle({ calendar: [{ items: [calItem] }] });
    const connector = createGoogleConnector(
      { resources: ["calendar"], calendarIds: ["primary"] },
      { clientFactory: () => client },
    );
    const [record] = await collect(connector.sync(ctx()));
    expect(record?.externalId).toBe("google:calendar:c1");
    expect(record?.meta.calendarId).toBeUndefined();
    // …and the id is still what gets fetched.
    expect(calls[0]).toEqual({ resource: "calendar", pageToken: undefined, calendarId: "primary" });
  });

  test("several calendars each get walked, and their event ids are namespaced", async () => {
    // One meeting carries the same event id in every calendar it lands on, so
    // without the namespace the two calendars would write one source that
    // flip-flops each sync (the ADR-0050 collision, one level down).
    const { client, calls } = fakeGoogle({ calendar: [{ items: [calItem] }] });
    const connector = createGoogleConnector(
      { resources: ["calendar"], calendarIds: ["primary", "team@group.calendar"] },
      { clientFactory: () => client },
    );
    const records = await collect(connector.sync(ctx()));
    expect(records.map((r) => r.externalId)).toEqual([
      "google:calendar:primary:c1",
      "google:calendar:team@group.calendar:c1",
    ]);
    expect(records.map((r) => r.meta.calendarId)).toEqual(["primary", "team@group.calendar"]);
    expect(calls.map((c) => c.calendarId)).toEqual(["primary", "team@group.calendar"]);
  });

  test("a duplicated calendar id is walked once", async () => {
    const { client, calls } = fakeGoogle({ calendar: [{ items: [calItem] }] });
    const connector = createGoogleConnector(
      { resources: ["calendar"], calendarIds: ["primary", "primary"] },
      { clientFactory: () => client },
    );
    const records = await collect(connector.sync(ctx()));
    expect(records).toHaveLength(1);
    // Deduplicated back to one calendar ⇒ back to the unnamespaced id.
    expect(records[0]?.externalId).toBe("google:calendar:c1");
    expect(calls).toHaveLength(1);
  });

  test("one unreadable calendar does not take the readable ones down", async () => {
    // Calendars are units of the existing per-resource isolation layer, so a
    // mistyped id is a warn + a skip, not a dead calendar family.
    const warns: string[] = [];
    const client: GoogleClientLike = {
      async listPage(_resource, _pageToken, calendarId) {
        if (calendarId === "typo@x") throw new Error("404 Not Found");
        return { items: [calItem] };
      },
      async downloadFile() {
        return new Uint8Array(0);
      },
      async exportFile() {
        return new Uint8Array(0);
      },
    };
    const connector = createGoogleConnector(
      { resources: ["calendar"], calendarIds: ["primary", "typo@x"] },
      { clientFactory: () => client },
    );
    const records = await collect(connector.sync(ctx({ onWarn: (m) => warns.push(m) })));
    expect(records.map((r) => r.externalId)).toEqual(["google:calendar:primary:c1"]);
    expect(warns.join("\n")).toContain("calendar[typo@x] (404 Not Found)");
    const result = await connector.finalize?.();
    expect(result?.partialFailure).toBe(true);
    expect(result?.summaryLines?.[0]).toBe(
      "resources: calendar[primary]=ok, calendar[typo@x]=failed (cursor preserved)",
    );
  });

  test("an empty calendarIds list ingests no calendar events (and says so in doctor)", async () => {
    const { client, calls } = fakeGoogle({ calendar: [{ items: [calItem] }] });
    const connector = createGoogleConnector(
      { resources: ["calendar"], calendarIds: [] },
      { clientFactory: () => client },
    );
    expect(await collect(connector.sync(ctx()))).toEqual([]);
    expect(calls).toEqual([]);
    // Silent 0 is the failure mode, so the advisory has to fire (ADR-0007).
    expect(manifest.noopWarning?.({ resources: ["calendar"], calendarIds: [] })).toContain(
      "calendarIds is empty",
    );
    // …but only when `calendar` is actually in scope.
    expect(manifest.noopWarning?.({ resources: ["drive"], calendarIds: [] })).toBeNull();
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

  // "empty scope + no credential still throws" (#385 / #404) is now enforced
  // centrally by the sync service (Issue #440) and covered for every connector by
  // the completeness test in `tests/connectors/manifest.test.ts`.
});

describe("Google connector — multi-account (ADR-0050 / #441)", () => {
  const item = (id: string) => ({
    id,
    title: `t-${id}`,
    detail: "",
    observedAt: "2026-07-01T00:00:00Z",
  });

  /** A client factory that records which client id / refresh token each call got. */
  function perAccountClients(pages: Record<string, GooglePage[]>): {
    factory: (auth: { clientId: string; refreshToken: string }) => GoogleClientLike;
    seen: Array<{ clientId: string; refreshToken: string }>;
    calendarCalls: Array<{ refreshToken: string; calendarId?: string }>;
  } {
    const seen: Array<{ clientId: string; refreshToken: string }> = [];
    const calendarCalls: Array<{ refreshToken: string; calendarId?: string }> = [];
    return {
      seen,
      calendarCalls,
      factory: (auth) => {
        seen.push(auth);
        const { client } = fakeGoogle({
          drive: pages[auth.refreshToken] ?? [],
          calendar: [{ items: [] }],
        });
        return {
          ...client,
          async listPage(resource, pageToken, calendarId) {
            if (resource === "calendar") {
              calendarCalls.push({ refreshToken: auth.refreshToken, calendarId });
            }
            return client.listPage(resource, pageToken, calendarId);
          },
        };
      },
    };
  }

  test("each account resolves its own credential and namespaces its external ids", async () => {
    const { factory, seen, calendarCalls } = perAccountClients({
      "rt-default": [{ items: [item("d1")] }],
      "rt-work": [{ items: [item("w1")] }],
    });
    const connector = createGoogleConnector(
      {
        clientId: "shared",
        resources: ["drive", "calendar"],
        accounts: { default: {}, work: { calendarIds: ["work@example.com"] } },
      },
      { clientFactory: factory },
    );
    const records = await collect(
      connector.sync(
        ctx({
          secret: async (name) =>
            name === "refreshToken"
              ? "rt-default"
              : name === "work:refreshToken"
                ? "rt-work"
                : null,
        }),
      ),
    );
    // `default` keeps the pre-ADR-0050 id, so an existing install's already
    // ingested lineage stays addressable; only the named account is prefixed.
    expect(records.map((r) => r.externalId)).toEqual(["google:drive:d1", "google:work:drive:w1"]);
    // `meta.account` is a display facet, present once the operator named the
    // account — never for the implicit single account (asserted below), so a
    // pre-ADR-0050 install's stored meta is not rewritten.
    expect(records[0]?.meta.account).toBe("default");
    expect(records[1]?.meta.account).toBe("work");
    // Inherited clientId, per-account credential.
    expect(seen).toEqual([
      { clientId: "shared", refreshToken: "rt-default" },
      { clientId: "shared", refreshToken: "rt-work" },
    ]);
    // Per-account calendar scope: the inherited default for one, the account's
    // own override for the other (ADR-0050 inheritance × ADR-0051 list).
    expect(calendarCalls).toEqual([
      { refreshToken: "rt-default", calendarId: "primary" },
      { refreshToken: "rt-work", calendarId: "work@example.com" },
    ]);
  });

  test("a tokenless account is skipped with a warning; the rest still sync", async () => {
    const { factory } = perAccountClients({ "rt-personal": [{ items: [item("p1")] }] });
    const warns: string[] = [];
    const connector = createGoogleConnector(
      { clientId: "c", resources: ["drive"], accounts: { personal: {}, work: {} } },
      { clientFactory: factory },
    );
    const records = await collect(
      connector.sync(
        ctx({
          secret: async (name) => (name === "personal:refreshToken" ? "rt-personal" : null),
          onWarn: (m) => warns.push(m),
        }),
      ),
    );
    expect(records.map((r) => r.externalId)).toEqual(["google:personal:drive:p1"]);
    expect(warns.join("\n")).toContain("account 'work' skipped: no refreshToken configured");
    const result = await connector.finalize?.();
    // Non-zero exit: an account the config declares ingested nothing.
    expect(result?.partialFailure).toBe(true);
    expect(result?.summaryLines).toContain("accounts: personal=ok, work=skipped");
  });

  test("one account's dead credential does not stop the other", async () => {
    const warns: string[] = [];
    const connector = createGoogleConnector(
      { clientId: "c", resources: ["drive"], accounts: { personal: {}, work: {} } },
      {
        clientFactory: (auth) => {
          if (auth.refreshToken === "dead") throw new Error("invalid_grant");
          return fakeGoogle({ drive: [{ items: [item("p1")] }] }).client;
        },
      },
    );
    const records = await collect(
      connector.sync(
        ctx({
          secret: async (name) => (name === "work:refreshToken" ? "dead" : "rt"),
          onWarn: (m) => warns.push(m),
        }),
      ),
    );
    expect(records.map((r) => r.externalId)).toEqual(["google:personal:drive:p1"]);
    expect(warns.join("\n")).toContain("work (invalid_grant)");
    expect((await connector.finalize?.())?.summaryLines).toContain(
      "accounts: personal=ok, work=failed",
    );
  });

  test("every account failing still throws (a total failure is not a partial success)", async () => {
    const connector = createGoogleConnector(
      { clientId: "c", resources: ["drive"], accounts: { personal: {}, work: {} } },
      {
        clientFactory: () => {
          throw new Error("invalid_grant");
        },
      },
    );
    await expect(
      collect(connector.sync(ctx({ secret: async () => "rt", onWarn: () => {} }))),
    ).rejects.toThrow("invalid_grant");
  });

  test("a per-resource failure is attributed to the account it happened in", async () => {
    const connector = createGoogleConnector(
      {
        clientId: "c",
        resources: ["drive", "gmail"],
        accounts: { personal: {}, work: { resources: ["drive"] } },
      },
      {
        clientFactory: (auth) =>
          auth.refreshToken === "rt-personal"
            ? fakeFailingGoogle({
                byResource: { drive: [{ items: [item("p1")] }] },
                failResources: { gmail: new Error("403 Forbidden") },
              })
            : fakeGoogle({ drive: [{ items: [item("w1")] }] }).client,
      },
    );
    const warns: string[] = [];
    await collect(
      connector.sync(
        ctx({
          secret: async (name) => (name === "personal:refreshToken" ? "rt-personal" : "rt-work"),
          onWarn: (m) => warns.push(m),
        }),
      ),
    );
    expect(warns.join("\n")).toContain("account 'personal': 1 resource OK, 1 failed");
    const result = await connector.finalize?.();
    expect(result?.partialFailure).toBe(true);
    expect(result?.summaryLines).toContain(
      "account 'personal' resources: drive=ok, gmail=failed (cursor preserved)",
    );
  });

  test("an account with no resources is a no-op, not a degraded run", async () => {
    // Empty scope keeps its pre-existing meaning (0 observed, exit 0) — turning
    // it into a partial failure would change the exit code of a config that was
    // deliberately narrowed.
    const connector = createGoogleConnector(
      { clientId: "c", accounts: { personal: {}, work: { resources: [] } } },
      { clientFactory: () => fakeGoogle({ drive: [{ items: [item("p1")] }] }).client },
    );
    await collect(connector.sync(ctx({ secret: async () => "rt", onWarn: () => {} })));
    expect((await connector.finalize?.())?.partialFailure).toBeUndefined();
  });

  test("a config with no accounts table is unchanged, id and meta included", async () => {
    const connector = createGoogleConnector(
      { clientId: "c", resources: ["drive"] },
      { clientFactory: () => fakeGoogle({ drive: [{ items: [item("d1")] }] }).client },
    );
    const records = await collect(connector.sync(ctx()));
    expect(records[0]?.externalId).toBe("google:drive:d1");
    expect(records[0]?.meta).not.toHaveProperty("account");
    expect((await connector.finalize?.())?.partialFailure).toBeUndefined();
  });

  test("self_addresses are unioned across accounts", async () => {
    const { resolveSelfAddresses } = await import("../../src/connectors/google.ts");
    expect(
      resolveSelfAddresses({
        self_addresses: ["Me@Personal.example"],
        accounts: { work: { self_addresses: ["me@work.example"] }, personal: {} },
      }),
    ).toEqual(["me@personal.example", "me@work.example"]);
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
