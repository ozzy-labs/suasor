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
