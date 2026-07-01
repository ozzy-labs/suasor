import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { authorFromMeta } from "../../src/connectors/author.ts";
import { channelFromMeta } from "../../src/connectors/channel.ts";
import type {
  Connector,
  SourceRecord,
  SyncContext,
  SyncResult,
} from "../../src/connectors/contract.ts";
import { syncConnector } from "../../src/connectors/index.ts";
import { Store } from "../../src/db/index.ts";
import { personIdFor } from "../../src/projections/person.ts";

let store: Store;

beforeEach(() => {
  store = Store.open({ path: ":memory:" });
});

afterEach(() => {
  store.close();
});

function fakeConnector(records: SourceRecord[], name: string): Connector {
  return {
    name,
    sourceType: name,
    async *sync(_ctx: SyncContext): AsyncIterable<SourceRecord> {
      for (const r of records) yield r;
    },
    finalize(): SyncResult {
      return { cursor: null };
    },
  };
}

function identity(connector: string, handle: string) {
  return store.connection.sqlite
    .query<{ person_id: string }, [string]>(
      "SELECT person_id FROM person_identities WHERE identity_key = ?",
    )
    .get(`${connector}:${handle}`);
}

/** The resolved display name stored on a (connector, handle) identity. */
function identityName(connector: string, handle: string): string | undefined {
  return store.connection.sqlite
    .query<{ display_name: string }, [string]>(
      "SELECT display_name FROM person_identities WHERE identity_key = ?",
    )
    .get(`${connector}:${handle}`)?.display_name;
}

describe("authorFromMeta (ADR-0022)", () => {
  test("maps github → meta.author, slack → meta.user", () => {
    expect(authorFromMeta("github", { author: "octocat" })).toEqual({
      connector: "github",
      handle: "octocat",
    });
    expect(authorFromMeta("slack", { user: "U123" })).toEqual({
      connector: "slack",
      handle: "U123",
    });
  });

  test("returns null for missing / blank / non-string / unknown connectors", () => {
    expect(authorFromMeta("github", {})).toBeNull();
    expect(authorFromMeta("github", { author: null })).toBeNull();
    expect(authorFromMeta("github", { author: "  " })).toBeNull();
    expect(authorFromMeta("web", { author: "x" })).toBeNull();
  });

  test("slack reads meta.userName into displayName (ADR-0037 §3)", () => {
    expect(authorFromMeta("slack", { user: "U123", userName: "Ada" })).toEqual({
      connector: "slack",
      handle: "U123",
      displayName: "Ada",
    });
  });

  test("blank / missing / non-string userName leaves displayName unset (degrade)", () => {
    expect(authorFromMeta("slack", { user: "U123" })?.displayName).toBeUndefined();
    expect(authorFromMeta("slack", { user: "U123", userName: "" })?.displayName).toBeUndefined();
    expect(authorFromMeta("slack", { user: "U123", userName: "  " })?.displayName).toBeUndefined();
    expect(authorFromMeta("slack", { user: "U123", userName: 42 })?.displayName).toBeUndefined();
  });

  test("github ignores a userName key (no display-name concept)", () => {
    expect(authorFromMeta("github", { author: "octocat", userName: "nope" })).toEqual({
      connector: "github",
      handle: "octocat",
    });
  });
});

describe("syncConnector records person identities (ADR-0022)", () => {
  test("a github source's author becomes a 1=1 person identity", async () => {
    await syncConnector(
      store,
      fakeConnector(
        [
          {
            externalId: "gh:org/repo:issue:1",
            sourceType: "github_issue",
            body: "hi",
            observedAt: "2026-06-14T00:00:00.000Z",
            meta: { author: "octocat" },
          },
        ],
        "github",
      ),
    );
    const row = identity("github", "octocat");
    expect(row?.person_id).toBe(personIdFor("github", "octocat"));
  });

  test("a record with no author records no identity (best-effort)", async () => {
    await syncConnector(
      store,
      fakeConnector(
        [
          {
            externalId: "gh:org/repo:issue:2",
            sourceType: "github_issue",
            body: "hi",
            observedAt: "2026-06-14T00:00:00.000Z",
            meta: { author: null },
          },
        ],
        "github",
      ),
    );
    expect(identity("github", "octocat")).toBeNull();
    const count = store.connection.sqlite
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM person_identities")
      .get();
    expect(count?.n).toBe(0);
  });

  test("a slack record's meta.userName lands on the person identity (ADR-0037 §4)", async () => {
    await syncConnector(
      store,
      fakeConnector(
        [
          {
            externalId: "slack:T1:C1:1700000000.000100",
            sourceType: "slack_message",
            body: "hi",
            observedAt: "2026-06-14T00:00:00.000Z",
            meta: { user: "U1", userName: "Ada Lovelace" },
          },
        ],
        "slack",
      ),
    );
    expect(identity("slack", "U1")?.person_id).toBe(personIdFor("slack", "U1"));
    expect(identityName("slack", "U1")).toBe("Ada Lovelace");
  });

  test("a slack record without userName leaves the id-derived name (degrade, §6)", async () => {
    await syncConnector(
      store,
      fakeConnector(
        [
          {
            externalId: "slack:T1:C1:1700000000.000200",
            sourceType: "slack_message",
            body: "hi",
            observedAt: "2026-06-14T00:00:00.000Z",
            meta: { user: "U2" },
          },
        ],
        "slack",
      ),
    );
    // No displayName emitted → reducer stores the empty-string default, never a
    // wrong name (the projection falls back to the id at display time).
    expect(identity("slack", "U2")?.person_id).toBe(personIdFor("slack", "U2"));
    expect(identityName("slack", "U2")).toBe("");
  });

  test("re-syncing the same author is idempotent (one identity row)", async () => {
    const records: SourceRecord[] = [
      {
        externalId: "gh:org/repo:issue:1",
        sourceType: "github_issue",
        body: "hi",
        observedAt: "2026-06-14T00:00:00.000Z",
        meta: { author: "octocat" },
      },
    ];
    await syncConnector(store, fakeConnector(records, "github"));
    // Change the body so the second pass emits SourceBodyUpdated (and re-observes).
    records[0] = { ...records[0], body: "hi again" } as SourceRecord;
    await syncConnector(store, fakeConnector(records, "github"));
    const count = store.connection.sqlite
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM person_identities")
      .get();
    expect(count?.n).toBe(1);
  });
});

/** The single slack_channels row for a channel id, or undefined. */
function slackChannel(channelId: string) {
  return store.connection.sqlite
    .query<{ channel_id: string; team_id: string; name: string; kind: string }, [string]>(
      "SELECT channel_id, team_id, name, kind FROM slack_channels WHERE channel_id = ?",
    )
    .get(channelId);
}

describe("channelFromMeta (ADR-0037 §3)", () => {
  test("maps slack meta.channel/team/channelKind/channelName", () => {
    expect(
      channelFromMeta("slack", {
        channel: "C1",
        team: "T1",
        channelKind: "public",
        channelName: "general",
      }),
    ).toEqual({ channelId: "C1", teamId: "T1", kind: "public", displayName: "general" });
  });

  test("a missing / blank channelName leaves displayName unset (degrade)", () => {
    expect(
      channelFromMeta("slack", { channel: "C1", team: "T1", channelKind: "public" })?.displayName,
    ).toBeUndefined();
    expect(
      channelFromMeta("slack", {
        channel: "C1",
        team: "T1",
        channelKind: "public",
        channelName: "  ",
      })?.displayName,
    ).toBeUndefined();
  });

  test("returns null for unknown connectors / missing id / invalid kind / missing team", () => {
    expect(
      channelFromMeta("github", { channel: "C1", team: "T1", channelKind: "public" }),
    ).toBeNull();
    expect(channelFromMeta("slack", { team: "T1", channelKind: "public" })).toBeNull();
    expect(
      channelFromMeta("slack", { channel: "C1", team: "T1", channelKind: "bogus" }),
    ).toBeNull();
    expect(channelFromMeta("slack", { channel: "C1", channelKind: "public" })).toBeNull();
  });
});

describe("syncConnector records slack channels (ADR-0037 §3)", () => {
  test("a slack record's channel meta becomes a slack_channels row", async () => {
    await syncConnector(
      store,
      fakeConnector(
        [
          {
            externalId: "slack:T1:C1:1700000000.000100",
            sourceType: "slack_message",
            body: "hi",
            observedAt: "2026-07-01T00:00:00.000Z",
            meta: {
              user: "U1",
              channel: "C1",
              team: "T1",
              channelKind: "public",
              channelName: "general",
            },
          },
        ],
        "slack",
      ),
    );
    expect(slackChannel("C1")).toEqual({
      channel_id: "C1",
      team_id: "T1",
      name: "general",
      kind: "public",
    });
  });

  test("emits one SlackChannelObserved per channel per run (deduped)", async () => {
    await syncConnector(
      store,
      fakeConnector(
        [
          {
            externalId: "slack:T1:C1:1.000100",
            sourceType: "slack_message",
            body: "a",
            observedAt: "2026-07-01T00:00:00.000Z",
            meta: { channel: "C1", team: "T1", channelKind: "public", channelName: "general" },
          },
          {
            externalId: "slack:T1:C1:2.000100",
            sourceType: "slack_message",
            body: "b",
            observedAt: "2026-07-01T00:00:01.000Z",
            meta: { channel: "C1", team: "T1", channelKind: "public", channelName: "general" },
          },
        ],
        "slack",
      ),
    );
    const n = store.connection.sqlite
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM events WHERE type = 'SlackChannelObserved'",
      )
      .get();
    expect(n?.n).toBe(1); // two messages, one channel event
  });

  test("a record with no channel meta records no channel (best-effort)", async () => {
    await syncConnector(
      store,
      fakeConnector(
        [
          {
            externalId: "gh:org/repo:issue:1",
            sourceType: "github_issue",
            body: "hi",
            observedAt: "2026-07-01T00:00:00.000Z",
            meta: { author: "octocat" },
          },
        ],
        "github",
      ),
    );
    const n = store.connection.sqlite
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM slack_channels")
      .get();
    expect(n?.n).toBe(0);
  });
});

/** The single slack_teams row for a team id, or undefined. */
function slackTeam(teamId: string) {
  return store.connection.sqlite
    .query<{ team_id: string; name: string }, [string]>(
      "SELECT team_id, name FROM slack_teams WHERE team_id = ?",
    )
    .get(teamId);
}

describe("syncConnector records slack teams (ADR-0037 §10, Issue #361)", () => {
  test("a slack record's team meta becomes a slack_teams row", async () => {
    await syncConnector(
      store,
      fakeConnector(
        [
          {
            externalId: "slack:T1:C1:1700000000.000100",
            sourceType: "slack_message",
            body: "hi",
            observedAt: "2026-07-01T00:00:00.000Z",
            meta: { user: "U1", channel: "C1", team: "T1", teamName: "Acme" },
          },
        ],
        "slack",
      ),
    );
    expect(slackTeam("T1")).toEqual({ team_id: "T1", name: "Acme" });
  });

  test("emits one SlackTeamObserved per team per run (deduped)", async () => {
    await syncConnector(
      store,
      fakeConnector(
        [
          {
            externalId: "slack:T1:C1:1.000100",
            sourceType: "slack_message",
            body: "a",
            observedAt: "2026-07-01T00:00:00.000Z",
            meta: { channel: "C1", team: "T1", teamName: "Acme" },
          },
          {
            externalId: "slack:T1:C2:2.000100",
            sourceType: "slack_message",
            body: "b",
            observedAt: "2026-07-01T00:00:01.000Z",
            meta: { channel: "C2", team: "T1", teamName: "Acme" },
          },
        ],
        "slack",
      ),
    );
    const n = store.connection.sqlite
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE type = 'SlackTeamObserved'")
      .get();
    expect(n?.n).toBe(1); // two messages same team, one team event
  });

  test("a degrade record (no teamName) records the team id with an empty name", async () => {
    await syncConnector(
      store,
      fakeConnector(
        [
          {
            externalId: "slack:T1:C1:1.000100",
            sourceType: "slack_message",
            body: "a",
            observedAt: "2026-07-01T00:00:00.000Z",
            meta: { channel: "C1", team: "T1" },
          },
        ],
        "slack",
      ),
    );
    expect(slackTeam("T1")).toEqual({ team_id: "T1", name: "" });
  });

  test("a record with no team meta records no team (best-effort)", async () => {
    await syncConnector(
      store,
      fakeConnector(
        [
          {
            externalId: "gh:org/repo:issue:1",
            sourceType: "github_issue",
            body: "hi",
            observedAt: "2026-07-01T00:00:00.000Z",
            meta: { author: "octocat" },
          },
        ],
        "github",
      ),
    );
    const n = store.connection.sqlite
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM slack_teams")
      .get();
    expect(n?.n).toBe(0);
  });
});
