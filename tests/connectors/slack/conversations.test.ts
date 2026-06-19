import { describe, expect, test } from "bun:test";
import {
  type ConversationType,
  listConversations,
  renderConfigBlock,
  type SlackConversationsTransport,
} from "../../../src/connectors/slack/conversations.ts";

/** Build a transport that returns a fixed body per requested `types` param. */
function fakeConvos(
  byType: Partial<Record<string, Record<string, unknown>[]>>,
  errors: Partial<Record<string, Record<string, unknown>>> = {},
): { transport: SlackConversationsTransport; calls: Record<string, string>[] } {
  const calls: Record<string, string>[] = [];
  const transport: SlackConversationsTransport = async (_token, params) => {
    calls.push(params);
    const apiType = params.types as string;
    if (errors[apiType]) return errors[apiType] as Record<string, unknown>;
    return { ok: true, channels: byType[apiType] ?? [] };
  };
  return { transport, calls };
}

describe("conversations — listConversations", () => {
  test("enumerates each type and labels channels / DMs / mpims", async () => {
    const { transport } = fakeConvos({
      public_channel: [{ id: "C1", name: "general", is_archived: false }],
      private_channel: [{ id: "G1", name: "secret" }],
      im: [{ id: "D1", user: "U9" }],
      mpim: [{ id: "G2", name: "mpdm-a--b--c" }],
    });
    const result = await listConversations("xoxb", { transport });
    const byId = Object.fromEntries(result.conversations.map((c) => [c.id, c]));
    expect(byId.C1?.displayName).toBe("#general");
    expect(byId.C1?.type).toBe("public");
    expect(byId.D1?.displayName).toBe("dm:U9");
    expect(byId.D1?.name).toBeNull();
    expect(byId.G2?.displayName).toBe("mpdm-a--b--c");
    expect(result.missingScopes).toEqual({});
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
});
