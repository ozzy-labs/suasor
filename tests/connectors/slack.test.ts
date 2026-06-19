import { describe, expect, test } from "bun:test";
import type { SourceRecord, SyncContext } from "../../src/connectors/contract.ts";
import {
  createSlackConnector,
  cursorToAliasMap,
  parseSinceToTs,
  resolveSelfUserIds,
  type SlackClientLike,
  SlackConnectorConfig,
  serializeCursor,
  workspaceSecretName,
} from "../../src/connectors/slack.ts";

type HistoryArgs = { channel: string; oldest?: string; limit?: number; cursor?: string };
type Msg = { ts: string; text?: string; user?: string; thread_ts?: string; reply_count?: number };
type HistoryPage = {
  messages?: Msg[];
  response_metadata?: { next_cursor?: string };
};
type ReplyCall = { channel: string; ts: string; oldest?: string };

function fakeSlack(
  pages: HistoryPage[],
  repliesByTs: Record<string, HistoryPage> = {},
): {
  client: SlackClientLike;
  calls: HistoryArgs[];
  replyCalls: ReplyCall[];
} {
  const calls: HistoryArgs[] = [];
  const replyCalls: ReplyCall[] = [];
  let i = 0;
  const client: SlackClientLike = {
    conversations: {
      async history(args) {
        calls.push(args);
        return pages[i++] ?? { messages: [] };
      },
      async replies(args) {
        replyCalls.push({ channel: args.channel, ts: args.ts, oldest: args.oldest });
        return repliesByTs[args.ts] ?? { messages: [] };
      },
    },
  };
  return { client, calls, replyCalls };
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
  test("legacy bare-ts cursor is applied as `oldest`; returns a per-channel map", async () => {
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
    // Cursor is now per-alias → per-channel; a single-workspace config is `default`.
    expect(JSON.parse(result?.cursor ?? "{}")).toEqual({ default: { C1: "1700000050.000000" } });
  });

  test("per-channel cursor: a quiet channel keeps its own floor (no cross-channel skip)", async () => {
    // C1 returns from its own floor (900), C2 from its own (500). The bug this
    // guards against raised C2's `oldest` to C1's ts, skipping C2's 500–900.
    const { client, calls } = fakeSlack([
      { messages: [{ ts: "1000.000000" }] }, // first history call → channel C1
      { messages: [{ ts: "700.000000" }] }, // second history call → channel C2
    ]);
    const connector = createSlackConnector(
      { team: "T1", channels: ["C1", "C2"] },
      { clientFactory: () => client },
    );
    await collect(
      connector.sync(ctx({ cursor: JSON.stringify({ C1: "900.000000", C2: "500.000000" }) })),
    );
    expect(calls.find((c) => c.channel === "C1")?.oldest).toBe("900.000000");
    expect(calls.find((c) => c.channel === "C2")?.oldest).toBe("500.000000");
    const result = await connector.finalize?.();
    expect(JSON.parse(result?.cursor ?? "{}")).toEqual({
      default: { C1: "1000.000000", C2: "700.000000" },
    });
  });

  test("drops cursor entries for channels no longer in config (no unbounded growth)", async () => {
    const { client } = fakeSlack([{ messages: [{ ts: "2000.000000" }] }]);
    const connector = createSlackConnector(
      { team: "T1", channels: ["C1"] },
      { clientFactory: () => client },
    );
    // The stored map still carries a stale C9 that is no longer configured.
    await collect(
      connector.sync(ctx({ cursor: JSON.stringify({ C1: "1000.000000", C9: "999.000000" }) })),
    );
    const result = await connector.finalize?.();
    expect(JSON.parse(result?.cursor ?? "{}")).toEqual({ default: { C1: "2000.000000" } });
  });

  test("a channel with no new messages preserves its floor", async () => {
    const { client } = fakeSlack([{ messages: [] }]);
    const connector = createSlackConnector(
      { team: "T1", channels: ["C1"] },
      { clientFactory: () => client },
    );
    await collect(connector.sync(ctx({ cursor: JSON.stringify({ C1: "1234.000000" }) })));
    const result = await connector.finalize?.();
    expect(JSON.parse(result?.cursor ?? "{}")).toEqual({ default: { C1: "1234.000000" } });
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

describe("Slack connector — multi-workspace (ADR-0014)", () => {
  test("workspaceSecretName: default workspace vs named alias", () => {
    expect(workspaceSecretName()).toBe("token");
    expect(workspaceSecretName("acme")).toBe("acme:token");
  });

  test("syncs each workspace with its own token and team-prefixed ids", async () => {
    const tokens: string[] = [];
    const { client } = fakeSlack([
      { messages: [{ ts: "10.000000" }] }, // acme → C1
      { messages: [{ ts: "20.000000" }] }, // beta → C2
    ]);
    const connector = createSlackConnector(
      {
        workspaces: {
          acme: { team: "TA", channels: ["C1"] },
          beta: { team: "TB", channels: ["C2"] },
        },
      },
      {
        clientFactory: (t) => {
          tokens.push(t);
          return client;
        },
      },
    );
    const records = await collect(
      connector.sync(
        ctx({
          secret: async (name) =>
            name === "acme:token" ? "tok-a" : name === "beta:token" ? "tok-b" : null,
        }),
      ),
    );
    expect(tokens).toEqual(["tok-a", "tok-b"]);
    expect(records.map((r) => r.externalId)).toEqual([
      "slack:TA:C1:10.000000",
      "slack:TB:C2:20.000000",
    ]);
    const result = await connector.finalize?.();
    expect(JSON.parse(result?.cursor ?? "{}")).toEqual({
      acme: { C1: "10.000000" },
      beta: { C2: "20.000000" },
    });
  });

  test("skips a workspace with no token (warns) and keeps syncing the rest", async () => {
    const warns: string[] = [];
    const tokens: string[] = [];
    const { client } = fakeSlack([{ messages: [{ ts: "30.000000" }] }]); // only beta fetches
    const connector = createSlackConnector(
      {
        workspaces: {
          acme: { team: "TA", channels: ["C1"] },
          beta: { team: "TB", channels: ["C2"] },
        },
      },
      {
        clientFactory: (t) => {
          tokens.push(t);
          return client;
        },
      },
    );
    const records = await collect(
      connector.sync(
        ctx({
          secret: async (name) => (name === "beta:token" ? "tok-b" : null), // acme missing
          onWarn: (m: string) => warns.push(m),
        }),
      ),
    );
    expect(tokens).toEqual(["tok-b"]); // acme never built a client (isolation)
    expect(records.map((r) => r.externalId)).toEqual(["slack:TB:C2:30.000000"]);
    expect(warns.some((w) => w.includes("acme") && w.includes("--workspace acme"))).toBe(true);
  });

  test("preserves a skipped workspace's prior cursor (skip is not a reset)", async () => {
    const { client } = fakeSlack([{ messages: [{ ts: "40.000000" }] }]);
    const connector = createSlackConnector(
      {
        workspaces: {
          acme: { team: "TA", channels: ["C1"] },
          beta: { team: "TB", channels: ["C2"] },
        },
      },
      { clientFactory: () => client },
    );
    await collect(
      connector.sync(
        ctx({
          secret: async (name) => (name === "beta:token" ? "tok-b" : null),
          cursor: JSON.stringify({ acme: { C1: "5.000000" }, beta: { C2: "9.000000" } }),
          onWarn: () => {},
        }),
      ),
    );
    const result = await connector.finalize?.();
    expect(JSON.parse(result?.cursor ?? "{}")).toEqual({
      acme: { C1: "5.000000" }, // preserved (skipped)
      beta: { C2: "40.000000" }, // advanced
    });
  });

  test("throws only when NO workspace resolves a token", async () => {
    const { client } = fakeSlack([]);
    const connector = createSlackConnector(
      { workspaces: { acme: { team: "TA", channels: ["C1"] } } },
      { clientFactory: () => client },
    );
    await expect(
      collect(connector.sync(ctx({ secret: async () => null, onWarn: () => {} }))),
    ).rejects.toThrow(/no token configured for any workspace/);
  });

  test("reads a flat (pre-multi-workspace) cursor as the default workspace", async () => {
    const { client, calls } = fakeSlack([{ messages: [{ ts: "100.000000" }] }]);
    const connector = createSlackConnector(
      { team: "T1", channels: ["C1"] },
      { clientFactory: () => client },
    );
    await collect(connector.sync(ctx({ cursor: JSON.stringify({ C1: "50.000000" }) })));
    expect(calls[0]?.oldest).toBe("50.000000");
    const result = await connector.finalize?.();
    expect(JSON.parse(result?.cursor ?? "{}")).toEqual({ default: { C1: "100.000000" } });
  });
});

describe("Slack connector — date floor (ADR-0016)", () => {
  const NOW = Date.UTC(2026, 0, 31, 0, 0, 0); // fixed clock (ms)
  const floorFor = (secondsAgo: number) => `${Math.floor(NOW / 1000) - secondsAgo}.000000`;

  test("parseSinceToTs: relative units and ISO date", () => {
    expect(parseSinceToTs("30d", NOW)).toBe(floorFor(30 * 86400));
    expect(parseSinceToTs("2w", NOW)).toBe(floorFor(2 * 604800));
    expect(parseSinceToTs("12h", NOW)).toBe(floorFor(12 * 3600));
    expect(parseSinceToTs("2026-01-01", NOW)).toBe(
      `${Math.floor(Date.parse("2026-01-01") / 1000)}.000000`,
    );
  });

  test("parseSinceToTs: unparseable → null", () => {
    expect(parseSinceToTs("nonsense", NOW)).toBeNull();
    expect(parseSinceToTs("5y", NOW)).toBeNull();
  });

  test("applies the `since` floor as `oldest` for an unsynced channel", async () => {
    const { client, calls } = fakeSlack([{ messages: [{ ts: floorFor(0) }] }]);
    const connector = createSlackConnector(
      { team: "T1", channels: ["C1"], since: "30d" },
      { clientFactory: () => client, now: () => NOW },
    );
    await collect(connector.sync(ctx()));
    expect(calls[0]?.oldest).toBe(floorFor(30 * 86400));
  });

  test("a saved cursor wins over the floor (resume, don't re-fetch older)", async () => {
    const { client, calls } = fakeSlack([{ messages: [] }]);
    const connector = createSlackConnector(
      { team: "T1", channels: ["C1"], since: "30d" },
      { clientFactory: () => client, now: () => NOW },
    );
    await collect(
      connector.sync(ctx({ cursor: JSON.stringify({ default: { C1: floorFor(1000) } }) })),
    );
    expect(calls[0]?.oldest).toBe(floorFor(1000)); // cursor, not the 30d floor
  });

  test("per-workspace `since` floors apply independently", async () => {
    const { client, calls } = fakeSlack([{ messages: [] }, { messages: [] }]);
    const connector = createSlackConnector(
      {
        workspaces: {
          acme: { team: "TA", channels: ["C1"], since: "7d" },
          beta: { team: "TB", channels: ["C2"], since: "1d" },
        },
      },
      {
        clientFactory: () => client,
        now: () => NOW,
        // both tokens present
      },
    );
    await collect(
      connector.sync(
        ctx({ secret: async (n) => (n === "acme:token" ? "a" : n === "beta:token" ? "b" : null) }),
      ),
    );
    expect(calls.find((c) => c.channel === "C1")?.oldest).toBe(floorFor(7 * 86400));
    expect(calls.find((c) => c.channel === "C2")?.oldest).toBe(floorFor(1 * 86400));
  });
});

describe("Slack connector — thread replies (ADR-0015)", () => {
  test("fetches replies for thread parents and skips the parent echo", async () => {
    const { client, replyCalls } = fakeSlack(
      [{ messages: [{ ts: "100.000000", reply_count: 2, thread_ts: "100.000000" }] }],
      {
        "100.000000": {
          messages: [
            { ts: "100.000000", text: "parent", thread_ts: "100.000000" }, // echoed → skipped
            { ts: "101.000000", text: "reply A", thread_ts: "100.000000" },
            { ts: "102.000000", text: "reply B", thread_ts: "100.000000" },
          ],
        },
      },
    );
    const connector = createSlackConnector(
      { team: "T1", channels: ["C1"] },
      { clientFactory: () => client },
    );
    const records = await collect(connector.sync(ctx()));
    expect(records.map((r) => r.externalId)).toEqual([
      "slack:T1:C1:100.000000", // parent, once (from history)
      "slack:T1:C1:101.000000",
      "slack:T1:C1:102.000000",
    ]);
    expect(records[1]?.meta).toMatchObject({ threadTs: "100.000000" });
    expect(replyCalls).toEqual([{ channel: "C1", ts: "100.000000", oldest: undefined }]);
    // The newest reply ts becomes the channel cursor.
    const result = await connector.finalize?.();
    expect(JSON.parse(result?.cursor ?? "{}")).toEqual({ default: { C1: "102.000000" } });
  });

  test("does not call replies for messages without replies (N+1 guard)", async () => {
    const { client, replyCalls } = fakeSlack([
      { messages: [{ ts: "100.000000" }, { ts: "101.000000", reply_count: 0 }] },
    ]);
    const connector = createSlackConnector(
      { team: "T1", channels: ["C1"] },
      { clientFactory: () => client },
    );
    await collect(connector.sync(ctx()));
    expect(replyCalls).toEqual([]);
  });

  test("passes the channel oldest to replies (resume window)", async () => {
    const { client, replyCalls } = fakeSlack(
      [{ messages: [{ ts: "500.000000", reply_count: 1, thread_ts: "500.000000" }] }],
      { "500.000000": { messages: [{ ts: "501.000000", thread_ts: "500.000000" }] } },
    );
    const connector = createSlackConnector(
      { team: "T1", channels: ["C1"] },
      { clientFactory: () => client },
    );
    await collect(
      connector.sync(ctx({ cursor: JSON.stringify({ default: { C1: "499.000000" } }) })),
    );
    expect(replyCalls[0]?.oldest).toBe("499.000000");
  });
});

describe("Slack cursor helpers (ADR-0016)", () => {
  test("cursorToAliasMap reads nested, flat, and bare-ts cursors", () => {
    expect(cursorToAliasMap(JSON.stringify({ default: { C1: "1.0" } }))).toEqual({
      default: { C1: "1.0" },
    });
    expect(cursorToAliasMap(JSON.stringify({ C1: "1.0" }))).toEqual({ default: { C1: "1.0" } });
    expect(cursorToAliasMap(null)).toEqual({});
    expect(cursorToAliasMap("1700.0")).toEqual({}); // bare ts has no per-channel structure
  });

  test("serializeCursor prunes empty aliases and returns null when empty", () => {
    expect(serializeCursor({ default: { C1: "1.0" }, beta: {} })).toBe(
      JSON.stringify({ default: { C1: "1.0" } }),
    );
    expect(serializeCursor({})).toBeNull();
    expect(serializeCursor({ acme: {} })).toBeNull();
  });
});

describe("resolveSelfUserIds (ADR-0012)", () => {
  test("collects flat + per-workspace ids, de-duplicated; empty when none", () => {
    expect(resolveSelfUserIds({ self_user_id: "U1" })).toEqual(["U1"]);
    expect(
      resolveSelfUserIds({
        workspaces: { a: { self_user_id: "U2" }, b: { self_user_id: "U3" } },
      }).sort(),
    ).toEqual(["U2", "U3"]);
    expect(
      resolveSelfUserIds({ self_user_id: "U1", workspaces: { a: { self_user_id: "U1" } } }),
    ).toEqual(["U1"]); // de-duplicated
    expect(resolveSelfUserIds({})).toEqual([]);
  });
});
