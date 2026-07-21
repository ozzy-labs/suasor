import { describe, expect, test } from "bun:test";
import { ConfigError } from "../../src/config/error.ts";
import type { SourceRecord, SyncContext } from "../../src/connectors/contract.ts";
import {
  createSlackConnector,
  cursorToChannelMap,
  isSinceParseable,
  isThreadActive,
  looksLikeSlackChannelId,
  parseSinceToTs,
  parseTokenPool,
  rejectLegacySlackConfig,
  resolveSelfUserIds,
  type SlackClientLike,
  SlackConnectorConfig,
  serializeCursor,
  sweepTypesForChannels,
  validateSlackSince,
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
    secret: async (name) => (name === "tokens" ? "xoxb-tok" : null),
    ...overrides,
  };
}

/** A `SyncContext` whose pool carries the given tokens (newline separated). */
function poolCtx(tokens: string[], overrides: Partial<SyncContext> = {}): SyncContext {
  return ctx({
    secret: async (name) => (name === "tokens" ? tokens.join("\n") : null),
    ...overrides,
  });
}

/** Offline conversations transport: the reachability sweep degrades to unknown. */
const offlineConversations = async (): Promise<Record<string, unknown>> => {
  throw new Error("offline");
};

async function collect(it: AsyncIterable<SourceRecord>): Promise<SourceRecord[]> {
  const out: SourceRecord[] = [];
  for await (const r of it) out.push(r);
  return out;
}

describe("SlackConnectorConfig", () => {
  test("defaults: empty channels", () => {
    const c = SlackConnectorConfig.parse({});
    expect(c.channels).toEqual([]);
    expect(c.self_user_ids).toBeUndefined();
  });
});

describe("parseTokenPool (ADR-0042)", () => {
  test("splits on newlines and commas, trims, drops empties, dedupes", () => {
    expect(parseTokenPool("a\nb")).toEqual(["a", "b"]);
    expect(parseTokenPool("a, b ,c")).toEqual(["a", "b", "c"]);
    expect(parseTokenPool(" a \n\n a ,")).toEqual(["a"]);
    expect(parseTokenPool("")).toEqual([]);
    expect(parseTokenPool(null)).toEqual([]);
    expect(parseTokenPool(undefined)).toEqual([]);
  });
});

describe("rejectLegacySlackConfig (ADR-0042 決定 9)", () => {
  test("rejects the removed ADR-0014 keys with migration guidance", () => {
    for (const legacy of [
      { workspaces: { acme: { team: "TA", channels: ["C1"] } } },
      { team: "T1", channels: ["C1"] },
      { self_user_id: "U1" },
    ]) {
      let thrown: unknown;
      try {
        rejectLegacySlackConfig(legacy);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ConfigError);
      expect((thrown as ConfigError).issues[0]).toContain("0042-slack-workspace-less-connector");
      expect((thrown as ConfigError).issues[0]).toContain("SUASOR_CONNECTOR_SLACK_TOKENS");
    }
  });

  test("accepts the flat workspace-less shape", () => {
    expect(() =>
      rejectLegacySlackConfig({ channels: ["C1"], self_user_ids: ["U1"], since: "30d" }),
    ).not.toThrow();
    expect(() => rejectLegacySlackConfig({})).not.toThrow();
  });

  test("createSlackConnector fails fast on a legacy config", () => {
    expect(() => createSlackConnector({ team: "T1", channels: ["C1"] })).toThrow(ConfigError);
    expect(() => createSlackConnector({ workspaces: { acme: { channels: ["C1"] } } })).toThrow(
      ConfigError,
    );
  });
});

describe("Slack connector — record mapping (ADR-0007 identity)", () => {
  test("maps messages to slack_message with canonical channel-prefixed ids (ADR-0042)", async () => {
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
    // auth.test self-description (ADR-0042 決定 2) supplies the display facet.
    client.authTest = async () => ({ ok: true, team: "Team One", team_id: "T1", user_id: "UB1" });
    const connector = createSlackConnector(
      { channels: ["C1"] },
      {
        clientFactory: () => client,
        usersTransport: async () => ({ ok: true, user: { profile: { display_name: "Ada" } } }),
      },
    );
    const records = await collect(connector.sync(ctx()));
    expect(records).toHaveLength(1);
    expect(records[0]?.externalId).toBe("slack:C1:1700000000.000100");
    expect(records[0]?.sourceType).toBe("slack_message");
    expect(records[0]?.body).toBe("hello team");
    expect(records[0]?.meta).toMatchObject({ team: "T1", channel: "C1", user: "U1" });
    expect(records[0]?.observedAt).toBe("2023-11-14T22:13:20.000Z");
  });

  test("a client with no authTest still ingests — meta.team is simply absent", async () => {
    const { client } = fakeSlack([{ messages: [{ ts: "1700000000.000100", text: "hi" }] }]);
    const connector = createSlackConnector({ channels: ["C1"] }, { clientFactory: () => client });
    const records = await collect(connector.sync(ctx()));
    expect(records).toHaveLength(1);
    expect(records[0]?.externalId).toBe("slack:C1:1700000000.000100");
    expect((records[0]?.meta as { team?: string }).team).toBeUndefined();
  });
});

describe("Slack connector — author name resolution (ADR-0037 §2)", () => {
  test("populates meta.userName from users.info, resolving each id once per run", async () => {
    const { client } = fakeSlack([
      {
        messages: [
          { ts: "1700000001.000000", text: "a", user: "U1" },
          { ts: "1700000002.000000", text: "b", user: "U1" }, // same id → cache hit
          { ts: "1700000003.000000", text: "c", user: "U2" },
        ],
      },
    ]);
    const lookups: string[] = [];
    const connector = createSlackConnector(
      { channels: ["C1"] },
      {
        clientFactory: () => client,
        usersTransport: async (_token, userId) => {
          lookups.push(userId);
          const names: Record<string, string> = { U1: "Ada", U2: "Grace" };
          return names[userId]
            ? { ok: true, user: { profile: { display_name: names[userId] } } }
            : { ok: false, error: "user_not_found" };
        },
      },
    );
    const records = await collect(connector.sync(ctx()));
    expect(records.map((r) => (r.meta as { userName?: string }).userName)).toEqual([
      "Ada",
      "Ada",
      "Grace",
    ]);
    // Per-run cache: U1 resolved once despite two messages (ADR-0037 §5).
    expect(lookups).toEqual(["U1", "U2"]);
  });

  test("degrades to no meta.userName when resolution fails (ADR-0037 §6)", async () => {
    const { client } = fakeSlack([
      { messages: [{ ts: "1700000001.000000", text: "a", user: "U1" }] },
    ]);
    const connector = createSlackConnector(
      { channels: ["C1"] },
      {
        clientFactory: () => client,
        // Simulate missing `users:read` scope — resolution must not abort ingest.
        usersTransport: async () => ({ ok: false, error: "missing_scope" }),
      },
    );
    const records = await collect(connector.sync(ctx()));
    expect(records).toHaveLength(1);
    expect(records[0]?.meta).toMatchObject({ user: "U1" });
    expect((records[0]?.meta as { userName?: string }).userName).toBeUndefined();
  });

  test("a message with no user carries no userName (no resolution attempted)", async () => {
    const { client } = fakeSlack([{ messages: [{ ts: "1700000001.000000", text: "sys" }] }]);
    let called = false;
    const connector = createSlackConnector(
      { channels: ["C1"] },
      {
        clientFactory: () => client,
        usersTransport: async () => {
          called = true;
          return { ok: true, user: { name: "x" } };
        },
      },
    );
    const records = await collect(connector.sync(ctx()));
    expect(called).toBe(false);
    expect((records[0]?.meta as { userName?: string }).userName).toBeUndefined();
  });
});

describe("Slack connector — delta cursor (FR-ING-3)", () => {
  test("legacy bare-ts cursor is applied as `oldest`; returns a per-channel map", async () => {
    const { client, calls } = fakeSlack([
      { messages: [{ ts: "1700000001.000000" }, { ts: "1700000050.000000" }] },
    ]);
    const connector = createSlackConnector({ channels: ["C1"] }, { clientFactory: () => client });
    await collect(connector.sync(ctx({ cursor: "1699999000.000000" })));
    expect(calls[0]?.oldest).toBe("1699999000.000000");
    const result = await connector.finalize?.();
    // Cursor is a flat channel → ts map (ADR-0042).
    expect(JSON.parse(result?.cursor ?? "{}")).toEqual({ C1: "1700000050.000000" });
  });

  test("per-channel cursor: a quiet channel keeps its own floor (no cross-channel skip)", async () => {
    // C1 returns from its own floor (900), C2 from its own (500). The bug this
    // guards against raised C2's `oldest` to C1's ts, skipping C2's 500–900.
    const { client, calls } = fakeSlack([
      { messages: [{ ts: "1000.000000" }] }, // first history call → channel C1
      { messages: [{ ts: "700.000000" }] }, // second history call → channel C2
    ]);
    const connector = createSlackConnector(
      { channels: ["C1", "C2"] },
      { clientFactory: () => client },
    );
    await collect(
      connector.sync(ctx({ cursor: JSON.stringify({ C1: "900.000000", C2: "500.000000" }) })),
    );
    expect(calls[0]?.oldest).toBe("900.000000");
    expect(calls[1]?.oldest).toBe("500.000000");
    const result = await connector.finalize?.();
    expect(JSON.parse(result?.cursor ?? "{}")).toEqual({ C1: "1000.000000", C2: "700.000000" });
  });

  test("a legacy nested (per-alias) cursor flattens with a max-ts merge (ADR-0042)", async () => {
    const { client, calls } = fakeSlack([{ messages: [] }]);
    const connector = createSlackConnector({ channels: ["C1"] }, { clientFactory: () => client });
    await collect(
      connector.sync(
        ctx({
          cursor: JSON.stringify({
            acme: { C1: "500.000000" },
            beta: { C1: "900.000000" }, // max wins
            __discovery__: { acme: "1700000000000:2" }, // legacy marker dropped
          }),
        }),
      ),
    );
    expect(calls[0]?.oldest).toBe("900.000000");
  });

  test("a channel with no new messages preserves its floor for the next run", async () => {
    const { client } = fakeSlack([{ messages: [] }]);
    const connector = createSlackConnector({ channels: ["C1"] }, { clientFactory: () => client });
    await collect(connector.sync(ctx({ cursor: JSON.stringify({ C1: "800.000000" }) })));
    const result = await connector.finalize?.();
    expect(JSON.parse(result?.cursor ?? "{}")).toEqual({ C1: "800.000000" });
  });
});

describe("Slack connector — guards", () => {
  test("a direct sync with an empty pool fails loudly via the unified no-live-token throw", async () => {
    // Production never reaches this (runSyncPass enforces the credential
    // precondition centrally, #440); a direct call still fails loudly (#458).
    const { client } = fakeSlack([]);
    const connector = createSlackConnector({ channels: ["C1"] }, { clientFactory: () => client });
    await expect(collect(connector.sync(ctx({ secret: async () => null })))).rejects.toThrow(
      /no usable token in the pool/,
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

  test("every pool token failing auth.test throws (replace the pool)", async () => {
    const dead: SlackClientLike = {
      ...fakeSlack([]).client,
      authTest: async () => {
        throw new Error("invalid_auth");
      },
    };
    const connector = createSlackConnector({ channels: ["C1"] }, { clientFactory: () => dead });
    await expect(collect(connector.sync(ctx({ onWarn: () => {} })))).rejects.toThrow(
      /no usable token in the pool/,
    );
  });
});

describe("Slack connector — non-id channel warn (#158)", () => {
  test("looksLikeSlackChannelId accepts C/D/G ids and rejects names", () => {
    expect(looksLikeSlackChannelId("C0123ABCD")).toBe(true);
    expect(looksLikeSlackChannelId("D0123ABCD")).toBe(true);
    expect(looksLikeSlackChannelId("G0123ABCD")).toBe(true);
    expect(looksLikeSlackChannelId("  C0123ABCD  ")).toBe(true); // trimmed
    expect(looksLikeSlackChannelId("#general")).toBe(false);
    expect(looksLikeSlackChannelId("general")).toBe(false);
  });

  test("warns once per non-id channel value but still syncs the configured channels", async () => {
    const { client } = fakeSlack([{ messages: [{ ts: "1700000000.000100", text: "hi" }] }]);
    const warns: string[] = [];
    const connector = createSlackConnector(
      { channels: ["#general"] },
      { clientFactory: () => client },
    );
    const records = await collect(connector.sync(ctx({ onWarn: (m) => warns.push(m) })));
    // The value is passed through to the API (no silent drop), and a single
    // actionable warning is surfaced (ADR-0007, hard-fail avoided).
    expect(records).toHaveLength(1);
    const idWarns = warns.filter((m) => m.includes("does not look like a Slack id"));
    expect(idWarns).toHaveLength(1);
    expect(idWarns[0]).toContain("#general");
    expect(idWarns[0]).toContain("slack conversations");
  });

  test("does not warn for valid ids", async () => {
    const { client } = fakeSlack([{ messages: [] }]);
    const warns: string[] = [];
    const connector = createSlackConnector(
      { channels: ["C0123ABCD"] },
      { clientFactory: () => client },
    );
    await collect(connector.sync(ctx({ onWarn: (m) => warns.push(m) })));
    expect(warns.filter((m) => m.includes("does not look like a Slack id"))).toHaveLength(0);
  });
});

describe("sweepTypesForChannels (#470)", () => {
  test("derives the sweep types from the configured id prefixes", () => {
    expect(sweepTypesForChannels(["C1"])).toEqual(["public", "private"]);
    expect(sweepTypesForChannels(["G1"])).toEqual(["private", "mpim"]);
    expect(sweepTypesForChannels(["D1"])).toEqual(["im"]);
    expect(sweepTypesForChannels(["C1", "D1"])).toEqual(["public", "private", "im"]);
    expect(sweepTypesForChannels([])).toEqual([]);
  });

  test("an unrecognised prefix falls back to all four types (safe over-sweep)", () => {
    expect(sweepTypesForChannels(["C1", "#general"])).toEqual(["public", "private", "im", "mpim"]);
  });
});

describe("Slack connector — token pool (ADR-0042)", () => {
  /** A per-token client whose history returns the given messages per channel. */
  function tokenClient(
    byChannel: Record<string, Msg[]>,
    identity?: { team?: string; team_id?: string; user_id?: string },
  ): SlackClientLike {
    const client: SlackClientLike = {
      conversations: {
        async history(args) {
          return { messages: byChannel[args.channel] ?? [] };
        },
        async replies() {
          return { messages: [] };
        },
      },
    };
    if (identity) client.authTest = async () => ({ ok: true, ...identity });
    return client;
  }

  test("a dead token is excluded (warn) and the rest of the pool still syncs", async () => {
    const warns: string[] = [];
    const dead: SlackClientLike = {
      ...fakeSlack([]).client,
      authTest: async () => {
        throw new Error("invalid_auth");
      },
    };
    const ok = tokenClient({ C1: [{ ts: "10.000000" }] }, { team: "Acme", team_id: "TA" });
    const connector = createSlackConnector(
      { channels: ["C1"] },
      {
        clientFactory: (t) => (t === "tok-dead" ? dead : ok),
        conversationsTransport: offlineConversations,
      },
    );
    const records = await collect(
      connector.sync(poolCtx(["tok-dead", "tok-ok"], { onWarn: (m: string) => warns.push(m) })),
    );
    expect(records.map((r) => r.externalId)).toEqual(["slack:C1:10.000000"]);
    expect(warns.some((w) => w.includes("token #1 is dead"))).toBe(true);
    const result = await connector.finalize?.();
    // Summary tells the dead token (replace it) apart from the live one.
    expect(result?.summaryLines?.[0]).toContain("#1=dead (replace it)");
    expect(result?.partialFailure).toBe(true);
  });

  test("a token-wide mid-sync failure fails over to the next token (bounded)", async () => {
    const warns: string[] = [];
    const bad: SlackClientLike = {
      conversations: {
        history: async () => {
          throw new Error("ratelimited");
        },
        replies: async () => ({ messages: [] }),
      },
      authTest: async () => ({ ok: true, team: "Acme", team_id: "TA" }),
    };
    const ok = tokenClient({ C1: [{ ts: "10.000000" }] }, { team: "Beta", team_id: "TB" });
    const connector = createSlackConnector(
      { channels: ["C1"] },
      {
        clientFactory: (t) => (t === "tok-bad" ? bad : ok),
        conversationsTransport: offlineConversations,
      },
    );
    const records = await collect(
      connector.sync(poolCtx(["tok-bad", "tok-ok"], { onWarn: (m: string) => warns.push(m) })),
    );
    // The failover token ingested the channel; the failed token is named.
    expect(records.map((r) => r.externalId)).toEqual(["slack:C1:10.000000"]);
    expect(warns.some((w) => w.includes("failed mid-sync"))).toBe(true);
    const result = await connector.finalize?.();
    expect(result?.partialFailure).toBe(true);
    expect(result?.summaryLines?.[0]).toContain('TA "Acme"=failed (cursor preserved)');
    expect(result?.summaryLines?.[0]).toContain('TB "Beta"=ok');
  });

  test("channel-scoped not_in_channel on one token fails over to the other", async () => {
    const notIn: SlackClientLike = {
      conversations: {
        history: async () => {
          const err = new Error("An API error occurred: not_in_channel") as Error & {
            data: { ok: false; error: string };
          };
          err.data = { ok: false, error: "not_in_channel" };
          throw err;
        },
        replies: async () => ({ messages: [] }),
      },
      authTest: async () => ({ ok: true, team: "Acme", team_id: "TA" }),
    };
    const ok = tokenClient({ C1: [{ ts: "10.000000" }] }, { team: "Beta", team_id: "TB" });
    const connector = createSlackConnector(
      { channels: ["C1"] },
      {
        clientFactory: (t) => (t === "tok-a" ? notIn : ok),
        conversationsTransport: offlineConversations,
      },
    );
    const warns: string[] = [];
    const records = await collect(
      connector.sync(poolCtx(["tok-a", "tok-b"], { onWarn: (m: string) => warns.push(m) })),
    );
    // Self-heal (ADR-0042): the second token reads the channel; no unreachable warn.
    expect(records.map((r) => r.externalId)).toEqual(["slack:C1:10.000000"]);
    expect(warns.some((w) => w.includes("unreachable"))).toBe(false);
    const result = await connector.finalize?.();
    expect(result?.partialFailure ?? false).toBe(false);
  });

  test("a channel no token can read lands in one aggregated unreachable warn", async () => {
    const notIn = (code: string): SlackClientLike => ({
      conversations: {
        history: async () => {
          const err = new Error(`An API error occurred: ${code}`) as Error & {
            data: { ok: false; error: string };
          };
          err.data = { ok: false, error: code };
          throw err;
        },
        replies: async () => ({ messages: [] }),
      },
      authTest: async () => ({ ok: true, team: "Acme", team_id: "TA" }),
    });
    const connector = createSlackConnector(
      { channels: ["C1"] },
      {
        clientFactory: () => notIn("not_in_channel"),
        conversationsTransport: offlineConversations,
      },
    );
    const warns: string[] = [];
    const records = await collect(
      connector.sync(poolCtx(["tok-a", "tok-b"], { onWarn: (m: string) => warns.push(m) })),
    );
    expect(records).toEqual([]);
    const warn = warns.find((w) => w.includes("unreachable"));
    expect(warn).toContain("C1 (not_in_channel)");
    expect(warn).toContain("no configured token can");
  });

  test("the reachability sweep only requests the types the config needs (#470)", async () => {
    const sweptTypes = new Set<string>();
    const transport = async (_token: string, params: Record<string, string>) => {
      sweptTypes.add(params.types as string);
      return { ok: true, channels: [] };
    };
    const mk = (teamId: string): SlackClientLike => ({
      conversations: {
        async history() {
          return { messages: [] };
        },
        async replies() {
          return { messages: [] };
        },
      },
      authTest: async () => ({ ok: true, team: teamId, team_id: teamId }),
    });
    const connector = createSlackConnector(
      // DM only → only the im type is swept (discovery is disabled so its
      // public+private sweep does not muddy the capture).
      { channels: ["D123"], discover_new: false },
      {
        clientFactory: (t) => (t === "tok-a" ? mk("TA") : mk("TB")),
        conversationsTransport: transport,
      },
    );
    await collect(connector.sync(poolCtx(["tok-a", "tok-b"], { onWarn: () => {} })));
    expect([...sweptTypes]).toEqual(["im"]);
  });

  test("reachability sweep orders candidates: the member token fetches the channel", async () => {
    const fetchedBy: string[] = [];
    const mk = (teamId: string): SlackClientLike => ({
      conversations: {
        async history(args) {
          fetchedBy.push(teamId);
          return { messages: args.channel === "C2" ? [{ ts: "20.000000" }] : [] };
        },
        async replies() {
          return { messages: [] };
        },
      },
      authTest: async () => ({ ok: true, team: teamId, team_id: teamId }),
    });
    // Transport keyed by token: tok-a is a member of C1 only, tok-b of C2 only.
    const membership: Record<string, string[]> = { "tok-a": ["C1"], "tok-b": ["C2"] };
    const transport = async (token: string, params: Record<string, string>) => {
      const wanted = params.types === "public_channel" ? (membership[token] ?? []) : [];
      return {
        ok: true,
        channels: wanted.map((id) => ({ id, name: id, is_member: true })),
      };
    };
    const connector = createSlackConnector(
      { channels: ["C2"] },
      {
        clientFactory: (t) => (t === "tok-a" ? mk("TA") : mk("TB")),
        conversationsTransport: transport,
      },
    );
    const records = await collect(connector.sync(poolCtx(["tok-a", "tok-b"])));
    expect(records.map((r) => r.externalId)).toEqual(["slack:C2:20.000000"]);
    // The member token (tok-b / TB) was preferred — no wasted first attempt.
    expect(fetchedBy).toEqual(["TB"]);
  });

  test("duplicate tokens for the same workspace are harmless (pool dedupes)", async () => {
    const client = tokenClient({ C1: [{ ts: "10.000000" }] }, { team: "Acme", team_id: "TA" });
    const connector = createSlackConnector({ channels: ["C1"] }, { clientFactory: () => client });
    const records = await collect(connector.sync(poolCtx(["tok-a", "tok-a"])));
    expect(records.map((r) => r.externalId)).toEqual(["slack:C1:10.000000"]);
  });
});

describe("Slack connector — shared-channel natural collapse (ADR-0042)", () => {
  test("a shared channel collapses to the same canonical externalId via any token", async () => {
    const warns: string[] = [];
    const mk = (teamId: string): SlackClientLike => ({
      conversations: {
        async history(args) {
          return { messages: args.channel === "C1" ? [{ ts: "10.000000", text: "shared" }] : [] };
        },
        async replies() {
          return { messages: [] };
        },
      },
      authTest: async () => ({ ok: true, team: teamId, team_id: teamId }),
    });
    const connector = createSlackConnector(
      { channels: ["C1"] },
      {
        clientFactory: (t) => (t === "tok-a" ? mk("TA") : mk("TB")),
        conversationsTransport: offlineConversations,
      },
    );
    const records = await collect(
      connector.sync(poolCtx(["tok-a", "tok-b"], { onWarn: (m: string) => warns.push(m) })),
    );
    // One fetch (first candidate succeeds — no owner election, no double fetch),
    // one canonical id; whichever token had fetched it, the id is identical.
    expect(records.map((r) => r.externalId)).toEqual(["slack:C1:10.000000"]);
    expect(warns.some((w) => w.includes("shared across"))).toBe(false);
  });

  test("cursor: the flat channel cursor advances regardless of which token fetched", async () => {
    const mk = (msgs: Msg[]): SlackClientLike => ({
      conversations: {
        async history() {
          return { messages: msgs };
        },
        async replies() {
          return { messages: [] };
        },
      },
      authTest: async () => ({ ok: true, team: "Acme", team_id: "TA" }),
    });
    const connector = createSlackConnector(
      { channels: ["C1"] },
      {
        clientFactory: () => mk([{ ts: "10.000000" }]),
        conversationsTransport: offlineConversations,
      },
    );
    await collect(connector.sync(poolCtx(["tok-a", "tok-b"])));
    const result = await connector.finalize?.();
    expect(JSON.parse(result?.cursor ?? "{}")).toEqual({ C1: "10.000000" });
  });
});

describe("Slack connector — not_in_channel per-channel warn (ADR-0011, #165)", () => {
  /**
   * A client whose `conversations.history` throws a `SlackAPIError`-shaped error
   * (`data.error`) for channels in `unreachable`, and returns one message for the
   * rest. Mirrors how `@slack/web-api` surfaces `ok:false` codes.
   */
  function perChannelClient(
    unreachable: Record<string, string>,
    ok: Record<string, Msg[]> = {},
  ): SlackClientLike {
    return {
      conversations: {
        async history(args) {
          const code = unreachable[args.channel];
          if (code) {
            const err = new Error(`An API error occurred: ${code}`) as Error & {
              data: { ok: false; error: string };
            };
            err.data = { ok: false, error: code };
            throw err;
          }
          return { messages: ok[args.channel] ?? [] };
        },
        async replies() {
          return { messages: [] };
        },
      },
    };
  }

  test("one unreachable channel: others still ingest, channel named in one warn", async () => {
    const warns: string[] = [];
    const client = perChannelClient(
      { C2: "not_in_channel" },
      { C1: [{ ts: "100.000000" }], C3: [{ ts: "200.000000" }] },
    );
    const connector = createSlackConnector(
      { channels: ["C1", "C2", "C3"] },
      { clientFactory: () => client },
    );
    const records = await collect(connector.sync(ctx({ onWarn: (m: string) => warns.push(m) })));
    // The two reachable channels ingested; the unreachable one is skipped.
    expect(records.map((r) => r.externalId)).toEqual([
      "slack:C1:100.000000",
      "slack:C3:200.000000",
    ]);
    // Exactly one aggregated warn naming C2 + the reason.
    const warn = warns.find((w) => w.includes("unreachable"));
    expect(warn).toBeDefined();
    expect(warn).toContain("C2 (not_in_channel)");
    expect(warn).not.toContain("C1");
    expect(warn).not.toContain("C3");
    // Cursor advanced for the reachable channels; C2 has no cursor (never read).
    const result = await connector.finalize?.();
    expect(JSON.parse(result?.cursor ?? "{}")).toEqual({
      C1: "100.000000",
      C3: "200.000000",
    });
  });

  test("all channels unreachable: aggregated warn lists each, no throw", async () => {
    const warns: string[] = [];
    const client = perChannelClient({ C1: "not_in_channel", C2: "channel_not_found" });
    const connector = createSlackConnector(
      { channels: ["C1", "C2"] },
      { clientFactory: () => client },
    );
    // All-channel unreachability is NOT a token failure — it does not throw (the
    // token was valid; the bot simply is not in any channel).
    const records = await collect(connector.sync(ctx({ onWarn: (m: string) => warns.push(m) })));
    expect(records).toEqual([]);
    const warn = warns.find((w) => w.includes("unreachable"));
    expect(warn).toContain("2 channel(s)");
    expect(warn).toContain("C1 (not_in_channel)");
    expect(warn).toContain("C2 (channel_not_found)");
  });

  test("unreachable channel preserves its prior cursor (skip is not a reset)", async () => {
    const client = perChannelClient({ C1: "not_in_channel" });
    const connector = createSlackConnector({ channels: ["C1"] }, { clientFactory: () => client });
    await collect(
      connector.sync(ctx({ cursor: JSON.stringify({ C1: "42.000000" }), onWarn: () => {} })),
    );
    const result = await connector.finalize?.();
    expect(JSON.parse(result?.cursor ?? "{}")).toEqual({ C1: "42.000000" });
  });

  test("a token-wide error (ratelimited) with a single token throws (all channels failed)", async () => {
    const client: SlackClientLike = {
      conversations: {
        history: async () => {
          throw new Error("ratelimited");
        },
        replies: async () => ({ messages: [] }),
      },
    };
    const connector = createSlackConnector({ channels: ["C1"] }, { clientFactory: () => client });
    // Only token → its sole error propagates (nothing ingested, nothing merely
    // unreachable).
    await expect(collect(connector.sync(ctx({ onWarn: () => {} })))).rejects.toThrow(/ratelimited/);
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
      { channels: ["C1"], since: "30d" },
      { clientFactory: () => client, now: () => NOW },
    );
    await collect(connector.sync(ctx()));
    expect(calls[0]?.oldest).toBe(floorFor(30 * 86400));
  });

  test("a saved cursor wins over the floor (resume, don't re-fetch older)", async () => {
    const { client, calls } = fakeSlack([{ messages: [] }]);
    const connector = createSlackConnector(
      { channels: ["C1"], since: "30d" },
      { clientFactory: () => client, now: () => NOW },
    );
    await collect(connector.sync(ctx({ cursor: JSON.stringify({ C1: floorFor(1000) }) })));
    expect(calls[0]?.oldest).toBe(floorFor(1000)); // cursor, not the 30d floor
  });

  test("per-channel `since` override wins over the connector since (#57)", async () => {
    const { client, calls } = fakeSlack([{ messages: [] }, { messages: [] }]);
    const connector = createSlackConnector(
      { channels: ["C1", "C2"], since: "30d", channel_since: { C2: "1d" } },
      { clientFactory: () => client, now: () => NOW },
    );
    await collect(connector.sync(ctx()));
    expect(calls.find((c) => c.channel === "C1")?.oldest).toBe(floorFor(30 * 86400)); // connector
    expect(calls.find((c) => c.channel === "C2")?.oldest).toBe(floorFor(1 * 86400)); // override
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
    const connector = createSlackConnector({ channels: ["C1"] }, { clientFactory: () => client });
    const records = await collect(connector.sync(ctx()));
    expect(records.map((r) => r.externalId)).toEqual([
      "slack:C1:100.000000", // parent, once (from history)
      "slack:C1:101.000000",
      "slack:C1:102.000000",
    ]);
    expect(records[1]?.meta).toMatchObject({ threadTs: "100.000000" });
    expect(replyCalls).toEqual([{ channel: "C1", ts: "100.000000", oldest: undefined }]);
    // The newest reply ts becomes the channel cursor.
    const result = await connector.finalize?.();
    expect(JSON.parse(result?.cursor ?? "{}")).toEqual({ C1: "102.000000" });
  });

  test("does not call replies for messages without replies (N+1 guard)", async () => {
    const { client, replyCalls } = fakeSlack([
      { messages: [{ ts: "100.000000" }, { ts: "101.000000", reply_count: 0 }] },
    ]);
    const connector = createSlackConnector({ channels: ["C1"] }, { clientFactory: () => client });
    await collect(connector.sync(ctx()));
    expect(replyCalls).toEqual([]);
  });

  test("passes the channel oldest to replies (resume window)", async () => {
    const { client, replyCalls } = fakeSlack(
      [{ messages: [{ ts: "500.000000", reply_count: 1, thread_ts: "500.000000" }] }],
      { "500.000000": { messages: [{ ts: "501.000000", thread_ts: "500.000000" }] } },
    );
    const connector = createSlackConnector({ channels: ["C1"] }, { clientFactory: () => client });
    await collect(connector.sync(ctx({ cursor: JSON.stringify({ C1: "499.000000" }) })));
    expect(replyCalls[0]?.oldest).toBe("499.000000");
  });
});

describe("Slack connector — steady-state thread re-poll (ADR-0015 R1, #418)", () => {
  // A fake whose history/replies honour Slack's exclusive `oldest` (only ts
  // strictly greater are returned), and whose `replies` returns the parent as the
  // first element (as Slack does), so the parent-echo skip is exercised.
  function oldestAwareSlack(
    historyMsgs: Msg[],
    repliesByTs: Record<string, Msg[]> = {},
  ): { client: SlackClientLike; replyCalls: ReplyCall[]; historyCalls: HistoryArgs[] } {
    const replyCalls: ReplyCall[] = [];
    const historyCalls: HistoryArgs[] = [];
    const after = (msgs: Msg[], oldest?: string): Msg[] =>
      oldest === undefined
        ? msgs
        : msgs.filter((m) => Number.parseFloat(m.ts) > Number.parseFloat(oldest));
    const client: SlackClientLike = {
      conversations: {
        async history(args) {
          historyCalls.push(args);
          return { messages: after(historyMsgs, args.oldest) };
        },
        async replies(args) {
          replyCalls.push({ channel: args.channel, ts: args.ts, oldest: args.oldest });
          return { messages: after(repliesByTs[args.ts] ?? [], args.oldest) };
        },
      },
    };
    return { client, replyCalls, historyCalls };
  }

  // A fixed "now" (2027) so relative-recency (30d active window) is deterministic.
  const NOW_MS = 1_800_000_000_000;
  const P = "1799990000.000000"; // thread parent, ~2.7h before now (active)
  const R1 = "1799990100.000000"; // first reply
  const M = "1799995000.000000"; // a later top-level message
  const R2 = "1799996000.000000"; // a new reply, newer than M

  test("captures a new reply after the channel cursor has passed the parent", async () => {
    // Run 1 (cold start): parent + its first reply are ingested; the channel
    // cursor and a per-thread high-water mark are persisted.
    const run1 = oldestAwareSlack([{ ts: P, text: "parent", reply_count: 1, thread_ts: P }], {
      [P]: [
        { ts: P, text: "parent", thread_ts: P }, // parent echo → skipped
        { ts: R1, text: "reply A", thread_ts: P },
      ],
    });
    const c1 = createSlackConnector(
      { channels: ["C1"] },
      { clientFactory: () => run1.client, now: () => NOW_MS },
    );
    const rec1 = await collect(c1.sync(ctx()));
    expect(rec1.map((r) => r.externalId)).toEqual([
      "slack:C1:1799990000.000000",
      "slack:C1:1799990100.000000",
    ]);
    const cursor1 = JSON.parse((await c1.finalize?.())?.cursor ?? "{}");
    // Both the channel cursor and the per-thread `<channel>#<thread_ts>` mark.
    expect(cursor1).toEqual({ C1: R1, [`C1#${P}`]: R1 });

    // Run 2 (steady state): a later top-level message has moved the channel
    // cursor past the parent, so the parent no longer appears in `history`. A new
    // reply (R2) must still be captured by re-polling the saved thread mark.
    const run2 = oldestAwareSlack([{ ts: M, text: "later top-level" }], {
      [P]: [
        { ts: P, text: "parent", thread_ts: P },
        { ts: R1, text: "reply A", thread_ts: P },
        { ts: R2, text: "hey <@U0SELF> please look", thread_ts: P }, // new reply w/ mention
      ],
    });
    const c2 = createSlackConnector(
      { channels: ["C1"] },
      { clientFactory: () => run2.client, now: () => NOW_MS },
    );
    const rec2 = await collect(c2.sync(ctx({ cursor: JSON.stringify(cursor1) })));
    // The later top-level message AND the re-polled reply are both ingested.
    expect(rec2.map((r) => r.externalId)).toEqual([
      "slack:C1:1799995000.000000",
      "slack:C1:1799996000.000000",
    ]);
    // The re-poll targets the thread with the saved mark as the exclusive floor.
    expect(run2.replyCalls).toEqual([{ channel: "C1", ts: P, oldest: R1 }]);
    // The captured reply carries its mention body + thread meta, so a `<@you>`
    // mention in a thread reply now reaches `slack.demand.list` (ADR-0012).
    const reply = rec2.find((r) => r.externalId === "slack:C1:1799996000.000000");
    expect(reply?.body).toContain("<@U0SELF>");
    expect(reply?.meta).toMatchObject({ threadTs: P });
    // The thread mark advances to the newest reply for the next run.
    const cursor2 = JSON.parse((await c2.finalize?.())?.cursor ?? "{}");
    expect(cursor2).toEqual({ C1: R2, [`C1#${P}`]: R2 });
  });

  test("prunes an inactive thread: no re-poll, its cursor is dropped", async () => {
    const stale = "1000000000.000000"; // year 2001 — far outside the 30d window
    const { client, replyCalls } = oldestAwareSlack([]); // no new history
    const connector = createSlackConnector(
      { channels: ["C1"] },
      { clientFactory: () => client, now: () => NOW_MS },
    );
    await collect(
      connector.sync(ctx({ cursor: JSON.stringify({ C1: P, [`C1#${stale}`]: stale }) })),
    );
    // The stale thread is never re-polled (bounded-cost guard).
    expect(replyCalls).toEqual([]);
    // Its per-thread cursor is pruned; the channel cursor is preserved.
    const cursor = JSON.parse((await connector.finalize?.())?.cursor ?? "{}");
    expect(cursor).toEqual({ C1: P });
  });

  test("re-polls an active thread with no new replies and keeps its mark", async () => {
    const { client, replyCalls } = oldestAwareSlack([], { [P]: [{ ts: P, thread_ts: P }] });
    const connector = createSlackConnector(
      { channels: ["C1"] },
      { clientFactory: () => client, now: () => NOW_MS },
    );
    await collect(connector.sync(ctx({ cursor: JSON.stringify({ C1: M, [`C1#${P}`]: R1 }) })));
    // The active thread is re-polled from its mark (returns only the parent echo,
    // which is skipped → nothing new ingested).
    expect(replyCalls).toEqual([{ channel: "C1", ts: P, oldest: R1 }]);
    // The mark is retained unchanged for the next run.
    const cursor = JSON.parse((await connector.finalize?.())?.cursor ?? "{}");
    expect(cursor).toEqual({ C1: M, [`C1#${P}`]: R1 });
  });

  test("isThreadActive: recent ts is active, older-than-window ts is not", () => {
    expect(isThreadActive(P, NOW_MS)).toBe(true);
    expect(isThreadActive("1000000000.000000", NOW_MS)).toBe(false);
    // Boundary: exactly 30 days old counts as active (inclusive floor).
    const floor = `${Math.floor(NOW_MS / 1000) - 30 * 86400}.000000`;
    expect(isThreadActive(floor, NOW_MS)).toBe(true);
  });
});

describe("Slack cursor helpers (ADR-0016 / ADR-0042)", () => {
  test("cursorToChannelMap reads flat, legacy nested, and bare-ts cursors", () => {
    expect(cursorToChannelMap(JSON.stringify({ C1: "1.0" }))).toEqual({ C1: "1.0" });
    // Legacy nested (ADR-0014) flattens with a max-ts merge per channel.
    expect(
      cursorToChannelMap(JSON.stringify({ acme: { C1: "1.0" }, beta: { C1: "2.0", C2: "3.0" } })),
    ).toEqual({ C1: "2.0", C2: "3.0" });
    expect(cursorToChannelMap(null)).toEqual({});
    expect(cursorToChannelMap("1700.0")).toEqual({}); // bare ts has no per-channel structure
  });

  test("serializeCursor returns null when empty", () => {
    expect(serializeCursor({ C1: "1.0" })).toBe(JSON.stringify({ C1: "1.0" }));
    expect(serializeCursor({})).toBeNull();
  });
});

describe("Slack `since` validation (Issue #157, ADR-0007)", () => {
  test("isSinceParseable: accepts relative units and ISO dates, rejects garbage", () => {
    // Parseable (clock-independent).
    for (const ok of ["30d", "4w", "12h", "2026-01-01", "2026-01-01T00:00:00Z"]) {
      expect(isSinceParseable(ok)).toBe(true);
    }
    // Unparseable values that would silently degrade to "no floor".
    for (const bad of ["3 weeks", "5y", "nonsense", "", "  "]) {
      expect(isSinceParseable(bad)).toBe(false);
    }
  });

  test("validateSlackSince: a valid config (relative + ISO) does not throw", () => {
    expect(() =>
      validateSlackSince(
        SlackConnectorConfig.parse({
          channels: ["C1", "C2"],
          since: "30d",
          channel_since: { C2: "2026-01-01" },
        }),
      ),
    ).not.toThrow();
  });

  test("createSlackConnector: a flat invalid `since` fails fast as ConfigError", () => {
    let thrown: unknown;
    try {
      createSlackConnector({ channels: ["C1"], since: "3 weeks" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as ConfigError).message).toContain("connectors.slack.since");
    expect((thrown as ConfigError).message).toContain("3 weeks");
  });

  test("createSlackConnector: an invalid `channel_since` entry fails fast", () => {
    expect(() =>
      createSlackConnector({ channels: ["C1"], channel_since: { C1: "bogus" } }),
    ).toThrow(ConfigError);
  });

  test("validateSlackSince: collects every offending entry in one error", () => {
    let thrown: unknown;
    try {
      validateSlackSince(
        SlackConnectorConfig.parse({
          channels: ["C1"],
          since: "3 weeks",
          channel_since: { C1: "bad" },
        }),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as ConfigError).issues).toHaveLength(2);
  });

  test("createSlackConnector: a valid `since` builds the connector", () => {
    expect(() => createSlackConnector({ channels: ["C1"], since: "30d" })).not.toThrow();
  });

  test("validateSlackSince: an invalid flat `since` error carries a backfill recovery hint", () => {
    let thrown: unknown;
    try {
      validateSlackSince(SlackConnectorConfig.parse({ channels: ["C1"], since: "3 weeks" }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    const [issue] = (thrown as ConfigError).issues;
    // Recovery hint names the backfill verb (Issue #380); no --workspace flag
    // remains (ADR-0042).
    expect(issue).toContain("suasor slack cursor backfill");
    expect(issue).not.toContain("--workspace");
    expect(issue).toContain("--channel <channel-id>");
  });

  test("validateSlackSince: an invalid `channel_since` hint embeds the concrete channel", () => {
    let thrown: unknown;
    try {
      validateSlackSince(
        SlackConnectorConfig.parse({ channels: ["C1"], channel_since: { C1: "bad" } }),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    const [issue] = (thrown as ConfigError).issues;
    expect(issue).toContain("--channel C1");
  });
});

describe("resolveSelfUserIds (ADR-0012 / ADR-0042)", () => {
  test("reads self_user_ids, deduplicated; empty when unset", () => {
    expect(resolveSelfUserIds({ self_user_ids: ["U1", "U2", "U1"] })).toEqual(["U1", "U2"]);
    expect(resolveSelfUserIds({})).toEqual([]);
    expect(resolveSelfUserIds({})).toEqual([]);
  });
});

describe("Slack connector — channel name resolution (ADR-0037 §3)", () => {
  test("populates meta.channelKind/channelName via conversations.info (cached per run)", async () => {
    const infoCalls: string[] = [];
    const { client } = fakeSlack([
      {
        messages: [
          { ts: "1.000000", text: "a" },
          { ts: "2.000000", text: "b" },
        ],
      },
    ]);
    client.conversations.info = async (args) => {
      infoCalls.push(args.channel);
      return { ok: true, channel: { name: "general" } };
    };
    const connector = createSlackConnector({ channels: ["C1"] }, { clientFactory: () => client });
    const records = await collect(connector.sync(ctx()));
    expect(records[0]?.meta).toMatchObject({ channelKind: "public", channelName: "general" });
    expect(records[1]?.meta).toMatchObject({ channelKind: "public", channelName: "general" });
    // Per-run cache: one conversations.info call for both messages (§5).
    expect(infoCalls).toEqual(["C1"]);
  });

  test("degrades to kind-only when conversations.info fails (§6)", async () => {
    const { client } = fakeSlack([{ messages: [{ ts: "1.000000", text: "a" }] }]);
    client.conversations.info = async () => {
      throw new Error("missing_scope");
    };
    const connector = createSlackConnector({ channels: ["C1"] }, { clientFactory: () => client });
    const records = await collect(connector.sync(ctx()));
    expect(records[0]?.meta).toMatchObject({ channelKind: "public" });
    expect((records[0]?.meta as { channelName?: string }).channelName).toBeUndefined();
  });
});

describe("Slack connector — team name resolution (ADR-0037 §10, Issue #361)", () => {
  test("populates meta.teamName from auth.test for the token's own team", async () => {
    const { client } = fakeSlack([{ messages: [{ ts: "1.000000", text: "a" }] }]);
    client.authTest = async () => ({ ok: true, team: "Acme Inc", team_id: "T1" });
    const connector = createSlackConnector({ channels: ["C1"] }, { clientFactory: () => client });
    const records = await collect(connector.sync(ctx()));
    expect(records[0]?.meta).toMatchObject({ team: "T1", teamName: "Acme Inc" });
  });

  test("degrades to no teamName when the client has no auth surface", async () => {
    const { client } = fakeSlack([{ messages: [{ ts: "1.000000", text: "a" }] }]);
    const connector = createSlackConnector({ channels: ["C1"] }, { clientFactory: () => client });
    const records = await collect(connector.sync(ctx()));
    expect((records[0]?.meta as { teamName?: string }).teamName).toBeUndefined();
  });
});
