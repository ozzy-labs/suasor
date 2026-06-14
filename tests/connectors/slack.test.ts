import { describe, expect, test } from "bun:test";
import type { SourceRecord, SyncContext } from "../../src/connectors/contract.ts";
import {
  createSlackConnector,
  type SlackClientLike,
  SlackConnectorConfig,
} from "../../src/connectors/slack.ts";

type HistoryArgs = { channel: string; oldest?: string; limit?: number; cursor?: string };
type HistoryPage = {
  messages?: Array<{ ts: string; text?: string; user?: string; thread_ts?: string }>;
  response_metadata?: { next_cursor?: string };
};

function fakeSlack(pages: HistoryPage[]): {
  client: SlackClientLike;
  calls: HistoryArgs[];
} {
  const calls: HistoryArgs[] = [];
  let i = 0;
  const client: SlackClientLike = {
    conversations: {
      async history(args) {
        calls.push(args);
        return pages[i++] ?? { messages: [] };
      },
    },
  };
  return { client, calls };
}

function ctx(overrides: Partial<SyncContext> = {}): SyncContext {
  return {
    cursor: null,
    secret: async (name) => (name === "token" ? "xoxb-tok" : null),
    ...overrides,
  };
}

async function collect(it: AsyncIterable<SourceRecord>): Promise<SourceRecord[]> {
  const out: SourceRecord[] = [];
  for await (const r of it) out.push(r);
  return out;
}

describe("SlackConnectorConfig", () => {
  test("defaults: empty channels, team 'default'", () => {
    const c = SlackConnectorConfig.parse({});
    expect(c.channels).toEqual([]);
    expect(c.team).toBe("default");
  });
});

describe("Slack connector — record mapping (ADR-0007 identity)", () => {
  test("maps messages to slack_message with team+channel-prefixed ids", async () => {
    const { client } = fakeSlack([
      {
        messages: [
          {
            ts: "1700000000.000100",
            text: "hello team",
            user: "U1",
            thread_ts: "1700000000.000100",
          },
        ],
      },
    ]);
    const connector = createSlackConnector(
      { team: "T1", channels: ["C1"] },
      { clientFactory: () => client },
    );
    const records = await collect(connector.sync(ctx()));
    expect(records).toHaveLength(1);
    expect(records[0]?.externalId).toBe("slack:T1:C1:1700000000.000100");
    expect(records[0]?.sourceType).toBe("slack_message");
    expect(records[0]?.body).toBe("hello team");
    expect(records[0]?.meta).toMatchObject({ team: "T1", channel: "C1", user: "U1" });
    expect(records[0]?.observedAt).toBe("2023-11-14T22:13:20.000Z");
  });
});

describe("Slack connector — delta cursor (FR-ING-3)", () => {
  test("passes the cursor as `oldest` and returns the max ts", async () => {
    const { client, calls } = fakeSlack([
      { messages: [{ ts: "1700000001.000000" }, { ts: "1700000050.000000" }] },
    ]);
    const connector = createSlackConnector(
      { team: "T1", channels: ["C1"] },
      { clientFactory: () => client },
    );
    await collect(connector.sync(ctx({ cursor: "1699999000.000000" })));
    expect(calls[0]?.oldest).toBe("1699999000.000000");
    const result = await connector.finalize?.();
    expect(result?.cursor).toBe("1700000050.000000");
  });

  test("first run omits `oldest` and paginates via next_cursor", async () => {
    const { client, calls } = fakeSlack([
      { messages: [{ ts: "1700000001.000000" }], response_metadata: { next_cursor: "p2" } },
      { messages: [{ ts: "1700000002.000000" }] },
    ]);
    const connector = createSlackConnector(
      { team: "T1", channels: ["C1"] },
      { clientFactory: () => client },
    );
    const records = await collect(connector.sync(ctx()));
    expect(calls[0]?.oldest).toBeUndefined();
    expect(calls[1]?.cursor).toBe("p2");
    expect(records).toHaveLength(2);
  });
});

describe("Slack connector — guards", () => {
  test("throws when no token is configured", async () => {
    const { client } = fakeSlack([]);
    const connector = createSlackConnector({ channels: ["C1"] }, { clientFactory: () => client });
    await expect(collect(connector.sync(ctx({ secret: async () => null })))).rejects.toThrow(
      /no token configured/,
    );
  });

  test("no channels configured yields nothing (and never builds a client)", async () => {
    let built = false;
    const connector = createSlackConnector(
      { channels: [] },
      {
        clientFactory: () => {
          built = true;
          return fakeSlack([]).client;
        },
      },
    );
    expect(await collect(connector.sync(ctx()))).toEqual([]);
    expect(built).toBe(false);
  });
});
