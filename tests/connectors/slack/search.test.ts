import { describe, expect, test } from "bun:test";
import {
  type SlackSearchTransport,
  searchLastSelfPost,
  sortByLastSelfPost,
} from "../../../src/connectors/slack/search.ts";

function fakeSearch(pagesByPage: Record<string, Record<string, unknown>>): {
  transport: SlackSearchTransport;
  calls: Record<string, string>[];
} {
  const calls: Record<string, string>[] = [];
  const transport: SlackSearchTransport = async (_token, params) => {
    calls.push(params);
    return (
      pagesByPage[params.page as string] ?? {
        ok: true,
        messages: { matches: [], paging: { pages: 1, page: Number(params.page) } },
      }
    );
  };
  return { transport, calls };
}

describe("search — searchLastSelfPost (ADR-0013)", () => {
  test("keeps the highest ts per channel and queries from:me", async () => {
    const { transport, calls } = fakeSearch({
      "1": {
        ok: true,
        messages: {
          matches: [
            { ts: "100.000000", channel: { id: "C1" } },
            { ts: "150.000000", channel: { id: "C1" } },
            { ts: "90.000000", channel: { id: "C2" } },
          ],
          paging: { pages: 1, page: 1 },
        },
      },
    });
    const map = await searchLastSelfPost("xoxp", { transport });
    expect(map.get("C1")).toBe("150.000000");
    expect(map.get("C2")).toBe("90.000000");
    expect(calls[0]?.query).toBe("from:me");
  });

  test("paginates across pages", async () => {
    const { transport } = fakeSearch({
      "1": {
        ok: true,
        messages: {
          matches: [{ ts: "10.0", channel: { id: "C1" } }],
          paging: { pages: 2, page: 1 },
        },
      },
      "2": {
        ok: true,
        messages: {
          matches: [{ ts: "20.0", channel: { id: "C1" } }],
          paging: { pages: 2, page: 2 },
        },
      },
    });
    const map = await searchLastSelfPost("xoxp", { transport });
    expect(map.get("C1")).toBe("20.0");
  });

  test("throws on a Slack error without leaking the token", async () => {
    const transport: SlackSearchTransport = async () => ({
      ok: false,
      error: "not_allowed_token_type",
    });
    const promise = searchLastSelfPost("xoxp-secret", { transport });
    await expect(promise).rejects.toThrow(/not_allowed_token_type/);
    await expect(promise).rejects.not.toThrow(/xoxp-secret/);
  });

  test("ignores matches missing channel or ts", async () => {
    const { transport } = fakeSearch({
      "1": {
        ok: true,
        messages: {
          matches: [
            { ts: "10.0" },
            { channel: { id: "C1" } },
            { ts: "20.0", channel: { id: "C2" } },
          ],
          paging: { pages: 1, page: 1 },
        },
      },
    });
    const map = await searchLastSelfPost("xoxp", { transport });
    expect(map.size).toBe(1);
    expect(map.get("C2")).toBe("20.0");
  });
});

describe("search — sortByLastSelfPost", () => {
  const convos = [{ id: "A" }, { id: "B" }, { id: "C" }];

  test("orders by last self-post ts descending; no-post items sort last", () => {
    const map = new Map([
      ["A", "100.0"],
      ["C", "300.0"],
    ]); // B has no self-post
    expect(sortByLastSelfPost(convos, map).map((c) => c.id)).toEqual(["C", "A", "B"]);
  });

  test("does not mutate the input array", () => {
    const input = [...convos];
    sortByLastSelfPost(input, new Map([["B", "9.0"]]));
    expect(input.map((c) => c.id)).toEqual(["A", "B", "C"]);
  });
});

describe("search — onProgress (#84)", () => {
  test("ticks once per fetched page", async () => {
    const { transport } = fakeSearch({
      "1": {
        ok: true,
        messages: { matches: [], paging: { pages: 3, page: 1 } },
      },
      "2": {
        ok: true,
        messages: { matches: [], paging: { pages: 3, page: 2 } },
      },
      "3": {
        ok: true,
        messages: { matches: [], paging: { pages: 3, page: 3 } },
      },
    });
    let ticks = 0;
    await searchLastSelfPost("xoxp", { transport, onProgress: () => (ticks += 1) });
    expect(ticks).toBe(3);
  });

  test("a throwing reporter never fails the search (best-effort)", async () => {
    const { transport } = fakeSearch({
      "1": { ok: true, messages: { matches: [], paging: { pages: 1, page: 1 } } },
    });
    const map = await searchLastSelfPost("xoxp", {
      transport,
      onProgress: () => {
        throw new Error("boom");
      },
    });
    expect(map.size).toBe(0);
  });
});
