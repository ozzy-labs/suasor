import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../../src/db/index.ts";
import type { NewEvent } from "../../src/events/types.ts";

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
