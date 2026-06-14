import { describe, expect, test } from "bun:test";
import type { SourceRecord, SyncContext } from "../../src/connectors/contract.ts";
import {
  createMsGraphConnector,
  type MsGraphClientLike,
  MsGraphConnectorConfig,
} from "../../src/connectors/ms-graph.ts";

type Page = {
  value: Array<{ id: string; [k: string]: unknown }>;
  "@odata.nextLink"?: string;
};

function fakeGraph(pagesByPath: Record<string, Page[]>): {
  client: MsGraphClientLike;
  paths: string[];
} {
  const paths: string[] = [];
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
  };
  return { client, paths };
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
      "/users/me/drive/root/children?$top=50&$select=id,name,lastModifiedDateTime": [
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
    expect(records.find((r) => r.sourceType === "ms365_file")?.externalId).toBe("msgraph:files:f1");
    expect(records.find((r) => r.sourceType === "ms365_teams_message")?.externalId).toBe(
      "msgraph:teams:t1",
    );
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
