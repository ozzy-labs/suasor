import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_EMBEDDING_DIM, DEFAULT_VEC_TABLE, Store } from "../../src/db/index.ts";
import type { NewEvent } from "../../src/events/types.ts";
import { upsertSourceVector } from "../../src/retrieval/embedding/recall.ts";

let store: Store;

beforeEach(() => {
  store = Store.open({ path: ":memory:" });
});

afterEach(() => {
  store.close();
});

/** Snapshot every projection table (incl. FTS) as comparable value rows. */
function snapshotProjections(store: Store): Record<string, unknown[]> {
  const sqlite = store.connection.sqlite;
  return {
    sources: sqlite.query("SELECT * FROM sources ORDER BY external_id").all(),
    tasks: sqlite.query("SELECT * FROM tasks ORDER BY id").all(),
    decisions: sqlite.query("SELECT * FROM decisions ORDER BY id").all(),
    inbox: sqlite.query("SELECT * FROM inbox ORDER BY id").all(),
    // links has an autoincrement id that resets on rebuild; compare by content.
    links: sqlite
      .query(
        "SELECT from_kind, from_id, to_kind, to_id, relation FROM links ORDER BY from_kind, from_id, to_kind, to_id, relation",
      )
      .all(),
    fts: sqlite.query("SELECT external_id, body FROM sources_fts ORDER BY external_id").all(),
  };
}

const SCRIPT: Array<{ event: NewEvent; at: string }> = [
  {
    event: {
      type: "SourceObserved",
      externalId: "gh:1",
      sourceType: "github_issue",
      body: "initial body 日本語のテスト",
      observedAt: "2026-06-14T00:00:00.000Z",
      fingerprint: "fp1",
      meta: { repo: "ozzy-labs/suasor" },
    },
    at: "2026-06-14T00:00:01.000Z",
  },
  {
    event: { type: "ConnectorSyncCompleted", connector: "github", cursor: "c1", count: 1 },
    at: "2026-06-14T00:00:02.000Z",
  },
  {
    event: {
      type: "SourceBodyUpdated",
      externalId: "gh:1",
      body: "updated body content",
      observedAt: "2026-06-14T01:00:00.000Z",
      fingerprint: "fp2",
      meta: { repo: "ozzy-labs/suasor", edited: true },
    },
    at: "2026-06-14T01:00:01.000Z",
  },
  {
    event: {
      type: "TaskProposed",
      taskId: "t1",
      title: "fix the bug",
      sourceExternalIds: ["gh:1"],
    },
    at: "2026-06-14T02:00:00.000Z",
  },
  {
    event: { type: "TaskApplied", taskId: "t1", state: "completed" },
    at: "2026-06-14T03:00:00.000Z",
  },
  {
    event: {
      type: "DecisionRecorded",
      decisionId: "d1",
      title: "adopt event sourcing",
      rationale: "provenance + rebuildable",
      sourceExternalIds: ["gh:1"],
    },
    at: "2026-06-14T04:00:00.000Z",
  },
  {
    event: {
      type: "ReplyDraftProposed",
      draftId: "r1",
      replyToExternalId: "gh:1",
      body: "thanks for the report",
    },
    at: "2026-06-14T05:00:00.000Z",
  },
  {
    event: {
      type: "InboxItemTriaged",
      inboxId: "i1",
      sourceExternalId: "gh:1",
      state: "done",
    },
    at: "2026-06-14T06:00:00.000Z",
  },
];

describe("rebuild idempotence (append → rebuild → deep-equal)", () => {
  test("rebuilt projections are value-identical to live-applied projections", () => {
    for (const { event, at } of SCRIPT) {
      store.record(event, new Date(at));
    }
    const before = snapshotProjections(store);

    const result = store.rebuild();
    expect(result.events).toBe(SCRIPT.length);

    const after = snapshotProjections(store);
    expect(after).toEqual(before);
  });

  test("repeated rebuilds are stable (rebuild ∘ rebuild = rebuild)", () => {
    for (const { event, at } of SCRIPT) {
      store.record(event, new Date(at));
    }
    store.rebuild();
    const once = snapshotProjections(store);
    store.rebuild();
    const twice = snapshotProjections(store);
    expect(twice).toEqual(once);
  });

  test("rebuild on an empty event log yields empty projections", () => {
    const result = store.rebuild();
    expect(result.events).toBe(0);
    const snap = snapshotProjections(store);
    for (const table of Object.values(snap)) {
      expect(table).toHaveLength(0);
    }
  });

  test("rebuild clears the vec0 substrate (vectors are re-synced, not replayed)", () => {
    const sqlite = store.connection.sqlite;
    store.record(
      {
        type: "SourceObserved",
        externalId: "gh:vec",
        sourceType: "github_issue",
        body: "embed me",
        observedAt: "2026-06-14T00:00:00.000Z",
        fingerprint: "fp",
        meta: {},
      },
      new Date("2026-06-14T00:00:01.000Z"),
    );
    // Vectors come from the delegated embedder (ADR-0006), not the event payload.
    upsertSourceVector(sqlite, "gh:vec", new Array(DEFAULT_EMBEDDING_DIM).fill(0.1));
    const vecBefore = sqlite.query(`SELECT count(*) AS n FROM ${DEFAULT_VEC_TABLE}`).get() as {
      n: number;
    };
    expect(vecBefore.n).toBe(1);

    store.rebuild();

    // The source projection is replayed back, but the vector is cleared (no stale
    // rows survive) and is regenerated on the next `<connector> sync`.
    const vecAfter = sqlite.query(`SELECT count(*) AS n FROM ${DEFAULT_VEC_TABLE}`).get() as {
      n: number;
    };
    expect(vecAfter.n).toBe(0);
    const sources = sqlite.query("SELECT count(*) AS n FROM sources").get() as { n: number };
    expect(sources.n).toBe(1);
  });

  test("FTS index is rebuilt and searchable after replay", () => {
    for (const { event, at } of SCRIPT) {
      store.record(event, new Date(at));
    }
    store.rebuild();
    const hits = store.connection.sqlite
      .query("SELECT external_id FROM sources_fts WHERE sources_fts MATCH ?")
      .all('"updated"');
    expect(hits).toHaveLength(1);
    // stale body removed during replay
    const stale = store.connection.sqlite
      .query("SELECT external_id FROM sources_fts WHERE sources_fts MATCH ?")
      .all('"initial"');
    expect(stale).toHaveLength(0);
  });
});
