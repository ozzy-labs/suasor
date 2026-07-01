import { describe, expect, test } from "bun:test";
import {
  resolveUserName,
  type SlackUsersTransport,
} from "../../../src/connectors/slack/resolve.ts";

/** A transport that records every call and answers from a fixed user table. */
function fakeUsers(users: Record<string, Record<string, unknown>>): {
  transport: SlackUsersTransport;
  calls: string[];
} {
  const calls: string[] = [];
  const transport: SlackUsersTransport = async (_token, userId) => {
    calls.push(userId);
    return users[userId]
      ? { ok: true, user: users[userId] }
      : { ok: false, error: "user_not_found" };
  };
  return { transport, calls };
}

describe("resolveUserName — fallback order (ADR-0037 §2)", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["profile.display_name wins", { profile: { display_name: "Ada" }, real_name: "Ada L" }, "Ada"],
    [
      "profile.real_name next",
      { profile: { real_name: "Ada Lovelace" }, real_name: "AL" },
      "Ada Lovelace",
    ],
    ["real_name next", { real_name: "Ada L", name: "ada" }, "Ada L"],
    ["name last", { name: "ada" }, "ada"],
  ];
  for (const [label, user, expected] of cases) {
    test(label, async () => {
      const { transport } = fakeUsers({ U1: user });
      const cache = new Map<string, string | null>();
      expect(await resolveUserName("tok", "U1", transport, cache)).toBe(expected);
    });
  }

  test("blank fields are skipped in the fallback chain", async () => {
    const { transport } = fakeUsers({
      U1: { profile: { display_name: "   ", real_name: "" }, real_name: "  ", name: "handle" },
    });
    expect(await resolveUserName("tok", "U1", transport, new Map())).toBe("handle");
  });
});

describe("resolveUserName — cache (ADR-0037 §5)", () => {
  test("the same id resolves the transport at most once", async () => {
    const { transport, calls } = fakeUsers({ U1: { name: "ada" } });
    const cache = new Map<string, string | null>();
    expect(await resolveUserName("tok", "U1", transport, cache)).toBe("ada");
    expect(await resolveUserName("tok", "U1", transport, cache)).toBe("ada");
    expect(calls).toEqual(["U1"]); // second call served from cache
  });

  test("a cached null (failed resolution) is not re-fetched", async () => {
    const { transport, calls } = fakeUsers({});
    const cache = new Map<string, string | null>();
    expect(await resolveUserName("tok", "Ux", transport, cache)).toBeNull();
    expect(await resolveUserName("tok", "Ux", transport, cache)).toBeNull();
    expect(calls).toEqual(["Ux"]);
  });
});

describe("resolveUserName — degrade to null (ADR-0037 §6)", () => {
  test("ok:false (e.g. missing users:read) returns null", async () => {
    const transport: SlackUsersTransport = async () => ({ ok: false, error: "missing_scope" });
    expect(await resolveUserName("tok", "U1", transport, new Map())).toBeNull();
  });

  test("a thrown transport error returns null (never propagates)", async () => {
    const transport: SlackUsersTransport = async () => {
      throw new Error("network down");
    };
    expect(await resolveUserName("tok", "U1", transport, new Map())).toBeNull();
  });

  test("a user with no name fields resolves to null", async () => {
    const { transport } = fakeUsers({ U1: { profile: {} } });
    expect(await resolveUserName("tok", "U1", transport, new Map())).toBeNull();
  });
});
