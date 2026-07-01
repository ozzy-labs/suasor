import { describe, expect, test } from "bun:test";
import { resolveTeamName, type SlackTeamClient } from "../../../src/connectors/slack/team.ts";

/** A client whose auth.test / auth.teams.list answer from fixed tables. */
function fakeClient(opts: {
  authTest?: { team?: string; team_id?: string; ok?: boolean };
  teams?: Array<{ id: string; name: string }>;
  teamsOk?: boolean;
  authTestCalls?: { n: number };
  teamsCalls?: { n: number };
}): SlackTeamClient {
  return {
    ...(opts.authTest !== undefined
      ? {
          authTest: async () => {
            if (opts.authTestCalls) opts.authTestCalls.n += 1;
            return { ok: opts.authTest?.ok ?? true, ...opts.authTest };
          },
        }
      : {}),
    ...(opts.teams !== undefined || opts.teamsOk !== undefined
      ? {
          authTeamsList: async () => {
            if (opts.teamsCalls) opts.teamsCalls.n += 1;
            return { ok: opts.teamsOk ?? true, teams: opts.teams ?? [] };
          },
        }
      : {}),
  };
}

const cache = () => new Map<string, string | null>();

describe("resolveTeamName — single workspace via auth.test (ADR-0037 §10)", () => {
  test("resolves the token's own team name", async () => {
    const client = fakeClient({ authTest: { team: "Acme", team_id: "T1" } });
    expect(await resolveTeamName(client, "T1", cache())).toBe("Acme");
  });

  test("associates auth.test's team name with the configured id (e.g. 'default')", async () => {
    // Flat config often uses team = "default"; auth.test still names the token's
    // workspace, associated with the configured join key.
    const client = fakeClient({ authTest: { team: "Acme", team_id: "T1" } });
    expect(await resolveTeamName(client, "default", cache())).toBe("Acme");
  });

  test("auth.test ok:false degrades to null (id fallback, §6)", async () => {
    const client = fakeClient({ authTest: { ok: false } });
    expect(await resolveTeamName(client, "T1", cache())).toBeNull();
  });
});

describe("resolveTeamName — Enterprise Grid via auth.teams.list (ADR-0037 §10)", () => {
  test("resolves a team from the Grid enumeration by id", async () => {
    const client = fakeClient({
      teams: [
        { id: "T1", name: "Acme" },
        { id: "T2", name: "Beta" },
      ],
    });
    expect(await resolveTeamName(client, "T2", cache())).toBe("Beta");
  });

  test("enumeration runs once per run, then serves ids from the cache", async () => {
    const teamsCalls = { n: 0 };
    const client = fakeClient({
      teams: [
        { id: "T1", name: "Acme" },
        { id: "T2", name: "Beta" },
      ],
      teamsCalls,
    });
    const shared = cache();
    expect(await resolveTeamName(client, "T1", shared)).toBe("Acme");
    expect(await resolveTeamName(client, "T2", shared)).toBe("Beta");
    expect(teamsCalls.n).toBe(1); // enumerated once, both ids served from cache
  });

  test("Grid enumeration is preferred, auth.test never called when the id is found", async () => {
    const authTestCalls = { n: 0 };
    const client = fakeClient({
      teams: [{ id: "T1", name: "Acme" }],
      authTest: { team: "Wrong", team_id: "T9" },
      authTestCalls,
    });
    expect(await resolveTeamName(client, "T1", cache())).toBe("Acme");
    expect(authTestCalls.n).toBe(0);
  });

  test("falls back to auth.test when the id is not in the enumeration", async () => {
    const client = fakeClient({
      teams: [{ id: "T2", name: "Beta" }],
      authTest: { team: "Acme", team_id: "T1" },
    });
    expect(await resolveTeamName(client, "T1", cache())).toBe("Acme");
  });

  test("non-Grid token (auth.teams.list ok:false) falls back to auth.test", async () => {
    const client = fakeClient({ teamsOk: false, authTest: { team: "Acme", team_id: "T1" } });
    expect(await resolveTeamName(client, "T1", cache())).toBe("Acme");
  });
});

describe("resolveTeamName — degrade (ADR-0037 §6)", () => {
  test("a client with neither method degrades to null (no network)", async () => {
    expect(await resolveTeamName({}, "T1", cache())).toBeNull();
  });

  test("a throwing auth.test is caught (best-effort, never propagates)", async () => {
    const client: SlackTeamClient = {
      authTest: async () => {
        throw new Error("network down");
      },
    };
    expect(await resolveTeamName(client, "T1", cache())).toBeNull();
  });

  test("a throwing auth.teams.list falls back to auth.test", async () => {
    const client: SlackTeamClient = {
      authTeamsList: async () => {
        throw new Error("network down");
      },
      authTest: async () => ({ ok: true, team: "Acme", team_id: "T1" }),
    };
    expect(await resolveTeamName(client, "T1", cache())).toBe("Acme");
  });

  test("caches a degrade so a second call does not re-fetch", async () => {
    const authTestCalls = { n: 0 };
    const client = fakeClient({ authTest: { ok: false }, authTestCalls });
    const shared = cache();
    expect(await resolveTeamName(client, "T1", shared)).toBeNull();
    expect(await resolveTeamName(client, "T1", shared)).toBeNull();
    expect(authTestCalls.n).toBe(1);
  });
});
