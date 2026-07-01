import { describe, expect, test } from "bun:test";
import {
  listTeams,
  type SlackTeamsTransport,
  slugifyAlias,
  workspaceAliases,
} from "../../../src/connectors/slack/teams.ts";

/** Build an auth.teams.list transport that replays queued page bodies. */
function fakeTeams(pages: Record<string, unknown>[]): {
  transport: SlackTeamsTransport;
  calls: Record<string, string>[];
} {
  const calls: Record<string, string>[] = [];
  let i = 0;
  const transport: SlackTeamsTransport = async (_token, params) => {
    calls.push(params);
    return pages[i++] ?? { ok: true, teams: [] };
  };
  return { transport, calls };
}

describe("teams — listTeams (#350)", () => {
  test("maps id/name and follows the cursor across pages", async () => {
    const { transport, calls } = fakeTeams([
      {
        ok: true,
        teams: [{ id: "T01", name: "Acme" }],
        response_metadata: { next_cursor: "P2" },
      },
      { ok: true, teams: [{ id: "T02", name: "Beta" }] },
    ]);
    const teams = await listTeams("xoxp", { transport });
    expect(teams).toEqual([
      { id: "T01", name: "Acme" },
      { id: "T02", name: "Beta" },
    ]);
    // The second call carried the cursor (the sweep was paginated).
    expect(calls[1]?.cursor).toBe("P2");
  });

  test("falls back to the id when a team has no name", async () => {
    const { transport } = fakeTeams([{ ok: true, teams: [{ id: "T09" }] }]);
    const teams = await listTeams("xoxp", { transport });
    expect(teams).toEqual([{ id: "T09", name: "T09" }]);
  });

  test("a non-ok response (missing_scope / enterprise_is_restricted) returns empty → caller falls back", async () => {
    const { transport } = fakeTeams([{ ok: false, error: "enterprise_is_restricted" }]);
    const teams = await listTeams("xoxp", { transport });
    expect(teams).toEqual([]);
  });

  test("a transport throw is swallowed (best-effort) and returns what was collected", async () => {
    const transport: SlackTeamsTransport = async () => {
      throw new Error("network down");
    };
    const teams = await listTeams("xoxp", { transport });
    expect(teams).toEqual([]);
  });

  test("onProgress ticks once per fetched page and a throwing reporter never fails the sweep", async () => {
    const { transport } = fakeTeams([
      { ok: true, teams: [{ id: "T1", name: "A" }], response_metadata: { next_cursor: "P2" } },
      { ok: true, teams: [{ id: "T2", name: "B" }] },
    ]);
    let ticks = 0;
    const teams = await listTeams("xoxp", {
      transport,
      onProgress: () => {
        ticks += 1;
        throw new Error("reporter boom");
      },
    });
    expect(teams.length).toBe(2);
    expect(ticks).toBe(2);
  });
});

describe("teams — slugifyAlias / workspaceAliases (#350)", () => {
  test("slugify lowercases, collapses non-alphanumerics, trims dashes", () => {
    expect(slugifyAlias("Acme Corp!", "T1")).toBe("acme-corp");
    expect(slugifyAlias("  --Beta--  ", "T2")).toBe("beta");
  });

  test("slugify falls back to the lower-cased id when the name has no usable chars", () => {
    expect(slugifyAlias("日本語", "T3")).toBe("t3");
    expect(slugifyAlias("", "T4")).toBe("t4");
  });

  test("workspaceAliases de-duplicates colliding slugs with a numeric suffix", () => {
    const aliases = workspaceAliases([
      { id: "T1", name: "Acme" },
      { id: "T2", name: "Acme" },
      { id: "T3", name: "Acme" },
    ]);
    expect(aliases.get("T1")).toBe("acme");
    expect(aliases.get("T2")).toBe("acme-2");
    expect(aliases.get("T3")).toBe("acme-3");
  });
});
