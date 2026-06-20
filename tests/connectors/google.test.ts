import { describe, expect, test } from "bun:test";
import type { SourceRecord, SyncContext } from "../../src/connectors/contract.ts";
import {
  createGoogleConnector,
  type GoogleClientLike,
  GoogleConnectorConfig,
  type GooglePage,
  type GoogleResource,
} from "../../src/connectors/google.ts";

function fakeGoogle(byResource: Partial<Record<GoogleResource, GooglePage[]>>): {
  client: GoogleClientLike;
  calls: Array<{ resource: GoogleResource; pageToken?: string }>;
} {
  const calls: Array<{ resource: GoogleResource; pageToken?: string }> = [];
  const cursors: Partial<Record<GoogleResource, number>> = {};
  const client: GoogleClientLike = {
    async listPage(resource, pageToken) {
      calls.push({ resource, pageToken });
      const list = byResource[resource] ?? [];
      const idx = cursors[resource] ?? 0;
      cursors[resource] = idx + 1;
      return list[idx] ?? { items: [] };
    },
  };
  return { client, calls };
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

    expect(records.find((r) => r.sourceType === "google_drive")?.externalId).toBe(
      "google:drive:d1",
    );
    const mail = records.find((r) => r.sourceType === "gmail_message");
    expect(mail?.externalId).toBe("google:gmail:g1");
    expect(mail?.body).toBe("Re: launch\n\nsnippet");
    expect(records.find((r) => r.sourceType === "google_calendar")?.externalId).toBe(
      "google:calendar:c1",
    );
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
