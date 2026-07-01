/**
 * `backfillSlackNames` (ADR-0037 §11/§12) against a real in-memory Store seeded
 * with `slack_message` sources. The Slack client + `users.info` transport + token
 * resolver are all injected with fakes, so the whole resolution path runs with no
 * network — the same seam PR1/PR2 use.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { backfillSlackNames } from "../../../src/connectors/slack/backfill.ts";
import type { SlackUsersTransport } from "../../../src/connectors/slack/resolve.ts";
import type { SlackClientLike, SlackConnectorConfig } from "../../../src/connectors/slack.ts";
import { SlackConnectorConfig as SlackConfigSchema } from "../../../src/connectors/slack.ts";
import { Store } from "../../../src/db/index.ts";
import { identityKey } from "../../../src/projections/person.ts";

let store: Store;

beforeEach(() => {
  store = Store.open({ path: ":memory:" });
});

/** Insert a `slack_message` source with the given connector meta. */
function seedSource(
  externalId: string,
  meta: { team: string; channel?: string; user?: string },
): void {
  store.connection.sqlite
    .query(
      `INSERT INTO sources (external_id, source_type, body, fingerprint, observed_at, meta)
       VALUES ($id, 'slack_message', 'hi', $fp, '1970-01-01T00:00:00.000Z', $meta)`,
    )
    .run({ $id: externalId, $fp: externalId, $meta: JSON.stringify(meta) });
}

/** users.info transport answering display names from a fixed id → name table. */
function fakeUsers(names: Record<string, string>): SlackUsersTransport {
  return async (_token, userId) =>
    names[userId]
      ? { ok: true, user: { profile: { display_name: names[userId] } } }
      : { ok: false, error: "user_not_found" };
}

/** A Slack client whose conversations.info/members answer from fixed tables. */
function fakeClient(opts: {
  info?: Record<string, Record<string, unknown>>;
  members?: Record<string, string[]>;
}): SlackClientLike {
  return {
    conversations: {
      history: async () => ({ messages: [] }),
      replies: async () => ({ messages: [] }),
      info: async ({ channel }) => {
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

/** Read a resolved channel name from the projection ("" when absent / unresolved). */
function channelName(channelId: string): string {
  const row = store.connection.sqlite
    .query("SELECT name FROM slack_channels WHERE channel_id = ?")
    .get(channelId) as { name: string } | null;
  return row?.name ?? "";
}

/** Read a resolved user display name from the person identity projection. */
function userName(handle: string): string {
  const row = store.connection.sqlite
    .query("SELECT display_name AS n FROM person_identities WHERE identity_key = ?")
    .get(identityKey("slack", handle)) as { n: string } | null;
  return row?.n ?? "";
}

/** Read a resolved team name from the slack_teams projection ("" when absent). */
function teamName(teamId: string): string {
  const row = store.connection.sqlite
    .query("SELECT name FROM slack_teams WHERE team_id = ?")
    .get(teamId) as { name: string } | null;
  return row?.name ?? "";
}

/** A Slack client that resolves team names from auth.test (single workspace). */
function fakeTeamClient(name: string): SlackClientLike {
  return {
    conversations: {
      history: async () => ({ messages: [] }),
      replies: async () => ({ messages: [] }),
    },
    authTest: async () => ({ ok: true, team: name }),
  };
}

/** A single-workspace config (team `T1`, default alias). */
function defaultConfig(overrides: Partial<SlackConnectorConfig> = {}): SlackConnectorConfig {
  return SlackConfigSchema.parse({ team: "T1", channels: [], ...overrides });
}

describe("backfillSlackNames (ADR-0037 §11)", () => {
  test("resolves unresolved channel + user names into the projections", async () => {
    seedSource("slack:T1:C1:1", { team: "T1", channel: "C1", user: "U1" });
    const summary = await backfillSlackNames(store, defaultConfig(), {
      clientFactory: async () => fakeClient({ info: { C1: { name: "general" } } }),
      usersTransport: fakeUsers({ U1: "Ada" }),
      secret: async () => "tok",
    });
    expect(channelName("C1")).toBe("general");
    expect(userName("U1")).toBe("Ada");
    expect(summary.channels).toEqual({ resolved: 1, skipped: 0, degraded: 0 });
    expect(summary.users).toEqual({ resolved: 1, skipped: 0, degraded: 0 });
  });

  test("dedups distinct ids across many sources (one resolve per id)", async () => {
    seedSource("slack:T1:C1:1", { team: "T1", channel: "C1", user: "U1" });
    seedSource("slack:T1:C1:2", { team: "T1", channel: "C1", user: "U1" });
    const summary = await backfillSlackNames(store, defaultConfig(), {
      clientFactory: async () => fakeClient({ info: { C1: { name: "general" } } }),
      usersTransport: fakeUsers({ U1: "Ada" }),
      secret: async () => "tok",
    });
    expect(summary.channels.resolved).toBe(1);
    expect(summary.users.resolved).toBe(1);
  });

  test("skips ids that already carry a resolved name (idempotent, §7)", async () => {
    seedSource("slack:T1:C1:1", { team: "T1", channel: "C1", user: "U1" });
    // Pre-resolve both via prior events, so the backfill should skip them.
    store.record({
      type: "SlackChannelObserved",
      channelId: "C1",
      teamId: "T1",
      kind: "public",
      displayName: "general",
    });
    store.record({
      type: "PersonIdentityObserved",
      personId: "person_x",
      connector: "slack",
      handle: "U1",
      displayName: "Ada",
    });
    let infoCalls = 0;
    const summary = await backfillSlackNames(store, defaultConfig(), {
      clientFactory: async () => ({
        conversations: {
          history: async () => ({ messages: [] }),
          replies: async () => ({ messages: [] }),
          info: async () => {
            infoCalls += 1;
            return { ok: true, channel: { name: "renamed" } };
          },
        },
      }),
      usersTransport: fakeUsers({ U1: "Bob" }),
      secret: async () => "tok",
    });
    expect(infoCalls).toBe(0); // never reached the network for a named id
    expect(summary.channels).toEqual({ resolved: 0, skipped: 1, degraded: 0 });
    expect(summary.users).toEqual({ resolved: 0, skipped: 1, degraded: 0 });
    expect(channelName("C1")).toBe("general"); // unchanged
    expect(userName("U1")).toBe("Ada");
  });

  test("--force re-resolves even already-named ids (last-write-wins)", async () => {
    seedSource("slack:T1:C1:1", { team: "T1", channel: "C1", user: "U1" });
    store.record({
      type: "SlackChannelObserved",
      channelId: "C1",
      teamId: "T1",
      kind: "public",
      displayName: "old",
    });
    store.record({
      type: "PersonIdentityObserved",
      personId: "person_x",
      connector: "slack",
      handle: "U1",
      displayName: "Old",
    });
    const summary = await backfillSlackNames(
      store,
      defaultConfig(),
      {
        clientFactory: async () => fakeClient({ info: { C1: { name: "new" } } }),
        usersTransport: fakeUsers({ U1: "New" }),
        secret: async () => "tok",
      },
      { force: true },
    );
    expect(channelName("C1")).toBe("new");
    expect(userName("U1")).toBe("New");
    expect(summary.channels.resolved).toBe(1);
    expect(summary.users.resolved).toBe(1);
    expect(summary.channels.skipped).toBe(0);
  });

  test("degrades (missing scope / API error) without aborting the pass (§6)", async () => {
    seedSource("slack:T1:C1:1", { team: "T1", channel: "C1", user: "U1" });
    seedSource("slack:T1:C2:1", { team: "T1", channel: "C2", user: "U2" });
    const summary = await backfillSlackNames(store, defaultConfig(), {
      // C1 resolves, C2 has no info entry → degrade. U1 resolves, U2 doesn't.
      clientFactory: async () => fakeClient({ info: { C1: { name: "general" } } }),
      usersTransport: fakeUsers({ U1: "Ada" }),
      secret: async () => "tok",
    });
    expect(channelName("C1")).toBe("general");
    expect(channelName("C2")).toBe(""); // id-only fallback
    expect(userName("U1")).toBe("Ada");
    expect(userName("U2")).toBe(""); // degraded → no name
    expect(summary.channels).toEqual({ resolved: 1, skipped: 0, degraded: 1 });
    expect(summary.users).toEqual({ resolved: 1, skipped: 0, degraded: 1 });
    // A degraded channel still records its id + kind (from the prefix).
    const kind = store.connection.sqlite
      .query("SELECT kind FROM slack_channels WHERE channel_id = 'C2'")
      .get() as { kind: string } | null;
    expect(kind?.kind).toBe("public");
  });

  test("resolves each workspace with its own token (no cross-resolution, ADR-0014)", async () => {
    seedSource("slack:T1:C1:1", { team: "T1", channel: "C1", user: "U1" });
    seedSource("slack:T2:C9:1", { team: "T2", channel: "C9", user: "U9" });
    const config = SlackConfigSchema.parse({
      workspaces: {
        default: { team: "T1", channels: ["C1"] },
        acme: { team: "T2", channels: ["C9"] },
      },
    });
    const tokensSeen: string[] = [];
    const summary = await backfillSlackNames(store, config, {
      clientFactory: async (token) => {
        tokensSeen.push(token);
        return token === "tok-default"
          ? fakeClient({ info: { C1: { name: "general" } } })
          : fakeClient({ info: { C9: { name: "acme-random" } } });
      },
      usersTransport: async (token, userId) =>
        token === "tok-default" && userId === "U1"
          ? { ok: true, user: { profile: { display_name: "Ada" } } }
          : token === "tok-acme" && userId === "U9"
            ? { ok: true, user: { profile: { display_name: "Zed" } } }
            : { ok: false },
      secret: async (name) => (name === "default:token" ? "tok-default" : "tok-acme"),
    });
    expect(channelName("C1")).toBe("general");
    expect(channelName("C9")).toBe("acme-random");
    expect(userName("U1")).toBe("Ada");
    expect(userName("U9")).toBe("Zed");
    expect(summary.channels.resolved).toBe(2);
    expect(summary.users.resolved).toBe(2);
    expect(new Set(tokensSeen)).toEqual(new Set(["tok-default", "tok-acme"]));
  });

  test("skips a workspace with no token and reports it", async () => {
    seedSource("slack:T1:C1:1", { team: "T1", channel: "C1", user: "U1" });
    const summary = await backfillSlackNames(store, defaultConfig(), {
      clientFactory: async () => fakeClient({ info: { C1: { name: "general" } } }),
      usersTransport: fakeUsers({ U1: "Ada" }),
      secret: async () => null, // no token
    });
    expect(summary.tokenlessWorkspaces).toEqual(["default"]);
    expect(channelName("C1")).toBe(""); // never resolved
    expect(summary.channels.resolved).toBe(0);
  });

  test("counts ids whose team no configured workspace claims as orphans", async () => {
    seedSource("slack:T1:C1:1", { team: "T1", channel: "C1", user: "U1" });
    seedSource("slack:TX:CX:1", { team: "TX", channel: "CX", user: "UX" });
    const summary = await backfillSlackNames(store, defaultConfig(), {
      clientFactory: async () => fakeClient({ info: { C1: { name: "general" } } }),
      usersTransport: fakeUsers({ U1: "Ada" }),
      secret: async () => "tok",
    });
    expect(channelName("C1")).toBe("general");
    expect(channelName("CX")).toBe(""); // no token/workspace for team TX
    expect(summary.orphanTeamIds).toBe(2); // CX + UX
    expect(summary.channels.resolved).toBe(1);
  });

  test("--workspace narrows the pass to one alias", async () => {
    seedSource("slack:T1:C1:1", { team: "T1", channel: "C1" });
    seedSource("slack:T2:C9:1", { team: "T2", channel: "C9" });
    const config = SlackConfigSchema.parse({
      workspaces: {
        default: { team: "T1", channels: ["C1"] },
        acme: { team: "T2", channels: ["C9"] },
      },
    });
    const summary = await backfillSlackNames(
      store,
      config,
      {
        clientFactory: async () =>
          fakeClient({ info: { C1: { name: "general" }, C9: { name: "acme" } } }),
        usersTransport: fakeUsers({}),
        secret: async () => "tok",
      },
      { workspace: "acme" },
    );
    expect(channelName("C9")).toBe("acme");
    expect(channelName("C1")).toBe(""); // out of scope, untouched
    // C1's team T1 is a known (in-config) workspace, just out of scope → not orphan.
    expect(summary.orphanTeamIds).toBe(0);
    expect(summary.channels.resolved).toBe(1);
  });

  test("no slack_message sources → an all-zero summary, no events", async () => {
    const summary = await backfillSlackNames(store, defaultConfig(), {
      clientFactory: async () => fakeClient({}),
      usersTransport: fakeUsers({}),
      secret: async () => "tok",
    });
    expect(summary.channels).toEqual({ resolved: 0, skipped: 0, degraded: 0 });
    expect(summary.users).toEqual({ resolved: 0, skipped: 0, degraded: 0 });
    expect(summary.teams).toEqual({ resolved: 0, skipped: 0, degraded: 0 });
    expect(summary.tokenlessWorkspaces).toEqual([]);
    expect(summary.orphanTeamIds).toBe(0);
  });
});

describe("backfillSlackNames — team names (ADR-0037 §10, Issue #361)", () => {
  test("resolves a workspace's team name into the projection", async () => {
    seedSource("slack:T1:C1:1", { team: "T1", channel: "C1" });
    const summary = await backfillSlackNames(store, defaultConfig(), {
      clientFactory: async () => fakeTeamClient("Acme"),
      usersTransport: fakeUsers({}),
      secret: async () => "tok",
    });
    expect(teamName("T1")).toBe("Acme");
    expect(summary.teams).toEqual({ resolved: 1, skipped: 0, degraded: 0 });
  });

  test("skips a team that already carries a resolved name (idempotent, §7)", async () => {
    seedSource("slack:T1:C1:1", { team: "T1", channel: "C1" });
    store.record({ type: "SlackTeamObserved", teamId: "T1", displayName: "Acme" });
    let authCalls = 0;
    const summary = await backfillSlackNames(store, defaultConfig(), {
      clientFactory: async () => ({
        conversations: {
          history: async () => ({ messages: [] }),
          replies: async () => ({ messages: [] }),
        },
        authTest: async () => {
          authCalls += 1;
          return { ok: true, team: "Renamed" };
        },
      }),
      usersTransport: fakeUsers({}),
      secret: async () => "tok",
    });
    expect(authCalls).toBe(0); // never reached the network for a named team
    expect(teamName("T1")).toBe("Acme"); // unchanged
    expect(summary.teams).toEqual({ resolved: 0, skipped: 1, degraded: 0 });
  });

  test("--force re-resolves an already-named team (last-write-wins)", async () => {
    seedSource("slack:T1:C1:1", { team: "T1", channel: "C1" });
    store.record({ type: "SlackTeamObserved", teamId: "T1", displayName: "Old" });
    const summary = await backfillSlackNames(
      store,
      defaultConfig(),
      {
        clientFactory: async () => fakeTeamClient("New"),
        usersTransport: fakeUsers({}),
        secret: async () => "tok",
      },
      { force: true },
    );
    expect(teamName("T1")).toBe("New");
    expect(summary.teams).toEqual({ resolved: 1, skipped: 0, degraded: 0 });
  });

  test("degrades (no resolver) recording the id with an empty name (§6)", async () => {
    seedSource("slack:T1:C1:1", { team: "T1", channel: "C1" });
    const summary = await backfillSlackNames(store, defaultConfig(), {
      // A client without authTest/authTeamsList → team name degrades to empty.
      clientFactory: async () => fakeClient({ info: { C1: { name: "general" } } }),
      usersTransport: fakeUsers({}),
      secret: async () => "tok",
    });
    expect(teamName("T1")).toBe(""); // id-only fallback
    expect(summary.teams).toEqual({ resolved: 0, skipped: 0, degraded: 1 });
  });

  test("resolves each workspace's team with its own token (no cross-resolution, ADR-0014)", async () => {
    seedSource("slack:T1:C1:1", { team: "T1", channel: "C1" });
    seedSource("slack:T2:C9:1", { team: "T2", channel: "C9" });
    const config = SlackConfigSchema.parse({
      workspaces: {
        default: { team: "T1", channels: ["C1"] },
        acme: { team: "T2", channels: ["C9"] },
      },
    });
    const summary = await backfillSlackNames(store, config, {
      clientFactory: async (token) =>
        token === "tok-default" ? fakeTeamClient("Default WS") : fakeTeamClient("Acme WS"),
      usersTransport: fakeUsers({}),
      secret: async (name) => (name === "default:token" ? "tok-default" : "tok-acme"),
    });
    expect(teamName("T1")).toBe("Default WS");
    expect(teamName("T2")).toBe("Acme WS");
    expect(summary.teams.resolved).toBe(2);
  });
});
