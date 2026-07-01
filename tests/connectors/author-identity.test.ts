import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { authorFromMeta } from "../../src/connectors/author.ts";
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
