import { describe, expect, test } from "bun:test";
import {
  channelKindFromId,
  type ResolvedChannel,
  resolveChannel,
  type SlackChannelInfoClient,
} from "../../../src/connectors/slack/channel.ts";
import type { SlackUsersTransport } from "../../../src/connectors/slack/resolve.ts";

/** A users transport answering names from a fixed table (id → display_name). */
function fakeUsers(names: Record<string, string>): SlackUsersTransport {
  return async (_token, userId) =>
    names[userId]
      ? { ok: true, user: { profile: { display_name: names[userId] } } }
      : { ok: false, error: "user_not_found" };
}

/** A client whose conversations.info/members answer from fixed tables. */
function fakeClient(opts: {
  info?: Record<string, Record<string, unknown>>;
  members?: Record<string, string[]>;
  infoCalls?: string[];
}): SlackChannelInfoClient {
  return {
    conversations: {
      info: async ({ channel }) => {
        opts.infoCalls?.push(channel);
        const ch = opts.info?.[channel];
        return ch ? { ok: true, channel: ch } : { ok: false };
      },
      members: async ({ channel }) => {
        const m = opts.members?.[channel];
        return m ? { ok: true, members: m } : { ok: false };
      },
    },
  };
}

const run = (
  client: SlackChannelInfoClient,
  channelId: string,
  self?: string,
  users: SlackUsersTransport = fakeUsers({}),
) =>
  resolveChannel(
    client,
    "tok",
    channelId,
    self,
    users,
    new Map<string, string | null>(),
    new Map<string, ResolvedChannel>(),
  );

describe("channelKindFromId (ADR-0037 §3)", () => {
  test("maps the id prefix to a kind", () => {
    expect(channelKindFromId("C1")).toBe("public");
    expect(channelKindFromId("D1")).toBe("dm");
    expect(channelKindFromId("G1")).toBe("group");
  });
});

describe("resolveChannel — public / private (ADR-0037 §3)", () => {
  test("public channel resolves name from conversations.info", async () => {
    const client = fakeClient({ info: { C1: { name: "general" } } });
    expect(await run(client, "C1")).toEqual({ name: "general", kind: "public" });
  });

  test("is_private classifies a C-id as a private channel", async () => {
    const client = fakeClient({ info: { C2: { name: "secret", is_private: true } } });
    expect(await run(client, "C2")).toEqual({ name: "secret", kind: "private" });
  });
});

describe("resolveChannel — DM (ADR-0037 §5)", () => {
  test("single DM resolves the counterpart's display name", async () => {
    const client = fakeClient({ info: { D1: { is_im: true, user: "U2" } } });
    expect(await run(client, "D1", "U1", fakeUsers({ U2: "Grace" }))).toEqual({
      name: "Grace",
      kind: "dm",
    });
  });

  test("an unresolvable counterpart degrades to an empty name (id fallback)", async () => {
    const client = fakeClient({ info: { D1: { is_im: true, user: "U2" } } });
    expect(await run(client, "D1", "U1", fakeUsers({}))).toEqual({ name: "", kind: "dm" });
  });
});

describe("resolveChannel — group DM (ADR-0037 §4)", () => {
  test("joins self-excluded participant names", async () => {
    const client = fakeClient({
      info: { G1: { is_mpim: true } },
      members: { G1: ["U1", "U2", "U3"] },
    });
    const out = await run(client, "G1", "U1", fakeUsers({ U2: "Grace", U3: "Ada" }));
    expect(out).toEqual({ name: "Grace, Ada", kind: "group" });
  });

  test("an unresolvable participant falls back to its id in the join", async () => {
    const client = fakeClient({
      info: { G1: { is_mpim: true } },
      members: { G1: ["U1", "U2", "U9"] },
    });
    const out = await run(client, "G1", "U1", fakeUsers({ U2: "Grace" }));
    expect(out).toEqual({ name: "Grace, U9", kind: "group" });
  });

  test("a missing members scope degrades to an empty name (whole-channel id fallback)", async () => {
    const client = fakeClient({ info: { G1: { is_mpim: true } } }); // no members table
    expect(await run(client, "G1", "U1")).toEqual({ name: "", kind: "group" });
  });
});

describe("resolveChannel — degrade (ADR-0037 §6)", () => {
  test("conversations.info ok:false degrades to id-prefix kind + empty name", async () => {
    const client = fakeClient({}); // info returns { ok: false }
    expect(await run(client, "C1")).toEqual({ name: "", kind: "public" });
    expect(await run(client, "D1")).toEqual({ name: "", kind: "dm" });
  });

  test("a client without conversations.info never reaches the network (id-only)", async () => {
    const client: SlackChannelInfoClient = { conversations: {} };
    expect(await run(client, "C1")).toEqual({ name: "", kind: "public" });
  });

  test("a throwing info transport is caught (best-effort, never propagates)", async () => {
    const client: SlackChannelInfoClient = {
      conversations: {
        info: async () => {
          throw new Error("network down");
        },
      },
    };
    expect(await run(client, "C1")).toEqual({ name: "", kind: "public" });
  });
});

describe("resolveChannel — per-run cache (ADR-0037 §5)", () => {
  test("the same channel resolves conversations.info at most once", async () => {
    const infoCalls: string[] = [];
    const client = fakeClient({ info: { C1: { name: "general" } }, infoCalls });
    const userCache = new Map<string, string | null>();
    const channelCache = new Map<string, ResolvedChannel>();
    const users = fakeUsers({});
    await resolveChannel(client, "tok", "C1", undefined, users, userCache, channelCache);
    await resolveChannel(client, "tok", "C1", undefined, users, userCache, channelCache);
    expect(infoCalls).toEqual(["C1"]); // second call served from the cache
  });
});
