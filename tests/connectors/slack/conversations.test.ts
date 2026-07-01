import { describe, expect, test } from "bun:test";
import {
  type ConversationType,
  listConversations,
  renderConfigBlock,
  type SlackConversationsTransport,
  type SlackUsersTransport,
} from "../../../src/connectors/slack/conversations.ts";

/** Build a conversations transport (+ users.info transport) for tests. */
function fakeConvos(
  byType: Partial<Record<string, Record<string, unknown>[]>>,
  errors: Partial<Record<string, Record<string, unknown>>> = {},
  users: Record<string, Record<string, unknown>> = {},
): {
  transport: SlackConversationsTransport;
  usersTransport: SlackUsersTransport;
  calls: Record<string, string>[];
} {
  const calls: Record<string, string>[] = [];
  const transport: SlackConversationsTransport = async (_token, params) => {
    calls.push(params);
    const apiType = params.types as string;
    if (errors[apiType]) return errors[apiType] as Record<string, unknown>;
    return { ok: true, channels: byType[apiType] ?? [] };
  };
  // users.info: resolve a known user, else report not-found (→ id fallback).
  const usersTransport: SlackUsersTransport = async (_token, userId) =>
    users[userId] ? { ok: true, user: users[userId] } : { ok: false, error: "user_not_found" };
  return { transport, usersTransport, calls };
}

describe("conversations — listConversations", () => {
  test("enumerates each type and labels channels / DMs (resolved name) / mpims", async () => {
    const { transport, usersTransport } = fakeConvos(
      {
        public_channel: [{ id: "C1", name: "general", is_archived: false }],
        private_channel: [{ id: "G1", name: "secret" }],
        im: [{ id: "D1", user: "U9" }],
        mpim: [{ id: "G2", name: "mpdm-a--b--c" }],
      },
      {},
      { U9: { profile: { display_name: "Alice" } } },
    );
    const result = await listConversations("xoxb", { transport, usersTransport });
    const byId = Object.fromEntries(result.conversations.map((c) => [c.id, c]));
    expect(byId.C1?.displayName).toBe("#general");
    expect(byId.C1?.type).toBe("public");
    expect(byId.D1?.displayName).toBe("dm:Alice"); // resolved via users.info (#1)
    expect(byId.D1?.name).toBeNull();
    expect(byId.G2?.displayName).toBe("mpdm-a--b--c");
    expect(result.missingScopes).toEqual({});
  });

  test("teamId option is sent as users.conversations team_id and tags each row (#350)", async () => {
    const { transport, calls } = fakeConvos({
      public_channel: [{ id: "C1", name: "general" }],
    });
    const result = await listConversations("xoxp", {
      types: ["public"],
      teamId: "T222",
      transport,
    });
    // Every page fetch carries the scoped team_id.
    expect(calls.every((p) => p.team_id === "T222")).toBe(true);
    // Every returned conversation is tagged with the scoped workspace.
    expect(result.conversations.every((c) => c.teamId === "T222")).toBe(true);
  });

  test("no teamId option → no team_id param and untagged rows (backward compatible, #350)", async () => {
    const { transport, calls } = fakeConvos({
      public_channel: [{ id: "C1", name: "general" }],
    });
    const result = await listConversations("xoxp", { types: ["public"], transport });
    expect(calls.every((p) => p.team_id === undefined)).toBe(true);
    expect(result.conversations.every((c) => c.teamId === undefined)).toBe(true);
  });

  test("resolves DM names (display_name → real_name → handle); falls back to dm:<id>", async () => {
    const { transport, usersTransport } = fakeConvos(
      {
        im: [
          { id: "D1", user: "U1" },
          { id: "D2", user: "U2" },
          { id: "D3", user: "U3" },
          { id: "D4", user: "U4" }, // unknown → users.info reports not_found
        ],
      },
      {},
      {
        U1: { profile: { display_name: "alice" } },
        U2: { profile: { display_name: "", real_name: "Bob R" } }, // empty display → real_name
        U3: { name: "carol" }, // only the handle
      },
    );
    const result = await listConversations("xoxb", { types: ["im"], transport, usersTransport });
    const byId = Object.fromEntries(result.conversations.map((c) => [c.id, c.displayName]));
    expect(byId.D1).toBe("dm:alice");
    expect(byId.D2).toBe("dm:Bob R");
    expect(byId.D3).toBe("dm:carol");
    expect(byId.D4).toBe("dm:U4"); // unresolved → id fallback (no throw)
  });

  test("sorts conversations a-z within each type (#2)", async () => {
    const { transport, usersTransport } = fakeConvos({
      public_channel: [
        { id: "C2", name: "zebra" },
        { id: "C1", name: "apple" },
        { id: "C3", name: "mango" },
      ],
    });
    const result = await listConversations("xoxb", {
      types: ["public"],
      transport,
      usersTransport,
    });
    expect(result.conversations.map((c) => c.displayName)).toEqual(["#apple", "#mango", "#zebra"]);
  });

  test("a missing listing scope self-reports per type without failing the sweep", async () => {
    const { transport } = fakeConvos(
      { public_channel: [{ id: "C1", name: "general" }] },
      { private_channel: { ok: false, error: "missing_scope", needed: "groups:read" } },
    );
    const result = await listConversations("xoxb", {
      types: ["public", "private"],
      transport,
    });
    expect(result.conversations.map((c) => c.id)).toEqual(["C1"]);
    expect(result.missingScopes.private).toBe("groups:read");
  });

  test("falls back to the canonical listing scope when `needed` is absent", async () => {
    const { transport } = fakeConvos({}, { im: { ok: false, error: "missing_scope" } });
    const result = await listConversations("xoxb", { types: ["im"], transport });
    expect(result.missingScopes.im).toBe("im:read");
  });

  test("a non-scope error throws (with the error code, never the token)", async () => {
    const { transport } = fakeConvos({}, { public_channel: { ok: false, error: "ratelimited" } });
    const promise = listConversations("xoxb-secret", { types: ["public"], transport });
    await expect(promise).rejects.toThrow(/ratelimited/);
  });

  test("paginates via response_metadata.next_cursor", async () => {
    let page = 0;
    const transport: SlackConversationsTransport = async (_t, params) => {
      page += 1;
      if (params.types !== "public_channel") return { ok: true, channels: [] };
      return page === 1
        ? {
            ok: true,
            channels: [{ id: "C1", name: "a" }],
            response_metadata: { next_cursor: "n2" },
          }
        : { ok: true, channels: [{ id: "C2", name: "b" }] };
    };
    const result = await listConversations("xoxb", { types: ["public"], transport });
    expect(result.conversations.map((c) => c.id)).toEqual(["C1", "C2"]);
  });

  test("--limit caps the total rows", async () => {
    const { transport } = fakeConvos({
      public_channel: [
        { id: "C1", name: "a" },
        { id: "C2", name: "b" },
        { id: "C3", name: "c" },
      ],
    });
    const result = await listConversations("xoxb", { types: ["public"], limit: 2, transport });
    expect(result.conversations).toHaveLength(2);
  });

  test("excludes archived by default and includes them on request", async () => {
    const make = () => fakeConvos({ public_channel: [{ id: "C1", name: "a" }] }).transport;
    const types: ConversationType[] = ["public"];
    const excludeCalls: Record<string, string>[] = [];
    const t1: SlackConversationsTransport = async (_t, p) => {
      excludeCalls.push(p);
      return { ok: true, channels: [] };
    };
    await listConversations("xoxb", { types, transport: t1 });
    expect(excludeCalls[0]?.exclude_archived).toBe("true");
    const includeCalls: Record<string, string>[] = [];
    const t2: SlackConversationsTransport = async (_t, p) => {
      includeCalls.push(p);
      return { ok: true, channels: [] };
    };
    await listConversations("xoxb", { types, includeArchived: true, transport: t2 });
    expect(includeCalls[0]?.exclude_archived).toBe("false");
    void make;
  });
});

describe("conversations — joined mark / isMember (ADR-0011, #165)", () => {
  test("channels report is_member; absent → false; DMs/MPIMs always true", async () => {
    const { transport, usersTransport } = fakeConvos(
      {
        public_channel: [
          { id: "C1", name: "joined", is_member: true },
          { id: "C2", name: "not-joined", is_member: false },
          { id: "C3", name: "unknown" }, // is_member absent → conservative false
        ],
        private_channel: [{ id: "G1", name: "secret", is_member: true }],
        im: [{ id: "D1", user: "U9" }], // DM → always joined
        mpim: [{ id: "G2", name: "mpdm-a--b--c" }], // MPIM → always joined
      },
      {},
      { U9: { profile: { display_name: "Alice" } } },
    );
    const result = await listConversations("xoxb", { transport, usersTransport });
    const byId = Object.fromEntries(result.conversations.map((c) => [c.id, c]));
    expect(byId.C1?.isMember).toBe(true);
    expect(byId.C2?.isMember).toBe(false);
    expect(byId.C3?.isMember).toBe(false); // absent is_member is not joined
    expect(byId.G1?.isMember).toBe(true);
    expect(byId.D1?.isMember).toBe(true); // DM
    expect(byId.G2?.isMember).toBe(true); // MPIM
  });

  test("DM name resolution preserves isMember", async () => {
    const { transport, usersTransport } = fakeConvos(
      { im: [{ id: "D1", user: "U9" }] },
      {},
      { U9: { profile: { display_name: "Alice" } } },
    );
    const result = await listConversations("xoxb", { transport, usersTransport });
    expect(result.conversations[0]?.displayName).toBe("dm:Alice");
    expect(result.conversations[0]?.isMember).toBe(true);
  });
});

describe("conversations — renderConfigBlock", () => {
  test("emits a paste-ready [connectors.slack] block with id comments", async () => {
    const { transport } = fakeConvos({
      public_channel: [{ id: "C1", name: "general" }],
    });
    const result = await listConversations("xoxb", { types: ["public"], transport });
    const block = renderConfigBlock("T1", result);
    expect(block[0]).toBe("[connectors.slack]");
    expect(block).toContain('team = "T1"');
    expect(block.join("\n")).toContain('"C1",  # #general');
  });

  test("emits an empty channels array when nothing is visible", () => {
    const block = renderConfigBlock("T1", { conversations: [], missingScopes: {} });
    expect(block).toContain("channels = []");
  });

  test("notes that channels are ids (not names) so a pasted name is not a footgun (#158)", async () => {
    const { transport } = fakeConvos({
      public_channel: [{ id: "C1", name: "general" }],
    });
    const result = await listConversations("xoxb", { types: ["public"], transport });
    const block = renderConfigBlock("T1", result).join("\n");
    expect(block).toContain("channels are ids");
    expect(block).toContain("not names");
  });
});

describe("conversations — onProgress (#84)", () => {
  test("ticks per fetched page and per resolved DM counterpart", async () => {
    const { transport, usersTransport } = fakeConvos(
      {
        public_channel: [{ id: "C1", name: "general" }],
        im: [
          { id: "D1", user: "U1" },
          { id: "D2", user: "U2" },
        ],
      },
      {},
      { U1: { profile: { display_name: "Alice" } }, U2: { profile: { display_name: "Bob" } } },
    );
    let ticks = 0;
    await listConversations("xoxb", {
      types: ["public", "im"],
      transport,
      usersTransport,
      onProgress: () => (ticks += 1),
    });
    // 2 page fetches (public + im) + 2 DM resolutions.
    expect(ticks).toBe(4);
  });

  test("a throwing reporter never fails the sweep (best-effort)", async () => {
    const { transport } = fakeConvos({ public_channel: [{ id: "C1", name: "general" }] });
    const result = await listConversations("xoxb", {
      types: ["public"],
      transport,
      onProgress: () => {
        throw new Error("boom");
      },
    });
    expect(result.conversations.map((c) => c.id)).toEqual(["C1"]);
  });
});
