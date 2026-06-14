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
