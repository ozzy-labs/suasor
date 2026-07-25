import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_EMBEDDING_DIM,
  DEFAULT_VEC_TABLE,
  Store,
  VEC_META_TABLE,
} from "../../src/db/index.ts";
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

  test("onProgress fires once per replayed event", () => {
    for (const { event, at } of SCRIPT) {
      store.record(event, new Date(at));
    }
    let ticks = 0;
    const result = store.rebuild({
      onProgress: () => {
        ticks += 1;
      },
    });
    expect(result.events).toBe(SCRIPT.length);
    expect(ticks).toBe(SCRIPT.length);
  });

  test("rebuild on an empty event log yields empty projections", () => {
    const result = store.rebuild();
    expect(result.events).toBe(0);
    const snap = snapshotProjections(store);
    for (const table of Object.values(snap)) {
      expect(table).toHaveLength(0);
    }
  });

  test("rebuild clears BOTH vec0 and embeddings_meta symmetrically (ADR-0005 §5, #414)", () => {
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
    // Vectors + their provenance come from the delegated embedder (ADR-0006), not
    // the event payload — both the vec0 row and its embeddings_meta row are set.
    upsertSourceVector(sqlite, "gh:vec", new Array(DEFAULT_EMBEDDING_DIM).fill(0.1), {
      modelId: "bge-m3",
      modelVersion: "1",
    });
    const count = (table: string) =>
      (sqlite.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect(count(DEFAULT_VEC_TABLE)).toBe(1);
    expect(count(VEC_META_TABLE)).toBe(1);

    const result = store.rebuild();

    // The source projection is replayed back, but the embedding sidecar is cleared
    // in BOTH substrates. Leaving embeddings_meta behind (the pre-fix bug) would
    // make `embeddings status` claim the source is embedded while its vector is
    // gone — recall silently empty (ADR-0005 §5). Recovery is `embeddings drain`.
    expect(count(DEFAULT_VEC_TABLE)).toBe(0);
    expect(count(VEC_META_TABLE)).toBe(0);
    expect(count("sources")).toBe(1);
    // The rebuild reports how many vectors it invalidated so the CLI can prompt
    // for a drain (0 on an embedding-less store).
    expect(result.clearedEmbeddings).toBe(1);
  });

  test("rebuild on an embedding-less store reports clearedEmbeddings = 0", () => {
    store.record(
      {
        type: "SourceObserved",
        externalId: "gh:plain",
        sourceType: "github_issue",
        body: "no vector here",
        observedAt: "2026-06-14T00:00:00.000Z",
        fingerprint: "fp",
        meta: {},
      },
      new Date("2026-06-14T00:00:01.000Z"),
    );
    const result = store.rebuild();
    expect(result.clearedEmbeddings).toBe(0);
  });

  test("rebuild clears a diverged sidecar (vec0 empty, embeddings_meta populated) and reports the loss", () => {
    // Reproduce the pre-fix corrupt state directly: a stale embeddings_meta row
    // with no matching vec0 vector (what the old rebuild left behind). The fixed
    // rebuild must clear the orphan meta AND count it as an invalidated embedding.
    const sqlite = store.connection.sqlite;
    store.record(
      {
        type: "SourceObserved",
        externalId: "gh:orphan",
        sourceType: "github_issue",
        body: "orphaned meta",
        observedAt: "2026-06-14T00:00:00.000Z",
        fingerprint: "fp",
        meta: {},
      },
      new Date("2026-06-14T00:00:01.000Z"),
    );
    sqlite
      .query(
        `INSERT INTO ${VEC_META_TABLE} (external_id, model_id, model_version, embedded_at)
         VALUES ('gh:orphan', 'bge-m3', '1', '2026-06-14T00:00:00.000Z')`,
      )
      .run();
    const result = store.rebuild();
    const metaN = sqlite.query(`SELECT count(*) AS n FROM ${VEC_META_TABLE}`).get() as {
      n: number;
    };
    expect(metaN.n).toBe(0);
    expect(result.clearedEmbeddings).toBe(1);
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

  test("rebuild leaves exactly one FTS row per source (deferred bulk reindex)", () => {
    // gh:1 is observed once then body-updated once in SCRIPT — under the old
    // per-event sync it was reindexed twice; the deferred rebuild must still
    // leave exactly one FTS row per live source (no dupes, no orphans).
    for (const { event, at } of SCRIPT) {
      store.record(event, new Date(at));
    }
    store.rebuild();
    const sqlite = store.connection.sqlite;
    const sources = sqlite.query("SELECT count(*) AS n FROM sources").get() as { n: number };
    const fts = sqlite.query("SELECT count(*) AS n FROM sources_fts").get() as { n: number };
    expect(fts.n).toBe(sources.n);
    // and the FTS external_id set matches the sources external_id set exactly
    const orphans = sqlite
      .query(
        "SELECT external_id FROM sources_fts WHERE external_id NOT IN (SELECT external_id FROM sources)",
      )
      .all();
    expect(orphans).toHaveLength(0);
  });
});

describe("replay equivalence (incremental == full rebuild)", () => {
  /** Insert a raw event row directly into the log (bypasses live apply). */
  function appendRaw(event: NewEvent & Record<string, unknown>, id: string, recordedAt: string) {
    const payload = JSON.stringify({ ...event, id, recordedAt, schemaVersion: 1 });
    store.connection.sqlite
      .query(
        "INSERT INTO events (id, type, schema_version, recorded_at, payload) VALUES (?, ?, 1, ?, ?)",
      )
      .run(id, event.type, recordedAt, payload);
  }

  test("a duplicated event in the log replays to the same projection (idempotent rebuild)", () => {
    // Append the SourceObserved + a TaskProposed twice as raw rows, then rebuild.
    // The reducer's content-keyed upserts must converge the duplicates to one row.
    appendRaw(
      SCRIPT[0]?.event as NewEvent & Record<string, unknown>,
      "01A",
      "2026-06-14T00:00:01.000Z",
    );
    appendRaw(
      SCRIPT[0]?.event as NewEvent & Record<string, unknown>,
      "01B",
      "2026-06-14T00:00:02.000Z",
    );
    const taskEvent: NewEvent = {
      type: "TaskProposed",
      taskId: "t1",
      title: "dup task",
      sourceExternalIds: ["gh:1"],
    };
    appendRaw(taskEvent as NewEvent & Record<string, unknown>, "02A", "2026-06-14T02:00:00.000Z");
    appendRaw(taskEvent as NewEvent & Record<string, unknown>, "02B", "2026-06-14T02:00:01.000Z");

    const result = store.rebuild();
    expect(result.events).toBe(4); // four raw rows replayed
    const snap = snapshotProjections(store);
    expect(snap.sources).toHaveLength(1);
    expect(snap.tasks).toHaveLength(1);
    expect(snap.links).toHaveLength(1); // the duplicate proposal does not duplicate the link
  });

  test("rebuild is stable regardless of how the same events were recorded live", () => {
    // Record the script live, snapshot, then rebuild from the log — they match.
    for (const { event, at } of SCRIPT) {
      store.record(event, new Date(at));
    }
    const live = snapshotProjections(store);
    store.rebuild();
    const replayed = snapshotProjections(store);
    expect(replayed).toEqual(live);
    // And a second rebuild remains the fixed point.
    store.rebuild();
    expect(snapshotProjections(store)).toEqual(replayed);
  });

  test("a partial state (proposal without its later apply) rebuilds consistently", () => {
    store.record(SCRIPT[0]?.event as NewEvent, new Date("2026-06-14T00:00:01.000Z"));
    store.record(
      { type: "TaskProposed", taskId: "t1", title: "open task", sourceExternalIds: ["gh:1"] },
      new Date("2026-06-14T02:00:00.000Z"),
    );
    const before = snapshotProjections(store);
    store.rebuild();
    expect(snapshotProjections(store)).toEqual(before);
    const task = (before.tasks as Array<{ state: string }>)[0];
    expect(task?.state).toBe("proposed"); // no apply → stays proposed
  });
});

describe("slack_channels rebuild (ADR-0037 §3 / §9)", () => {
  test("slack_channels is truncated + replayed on rebuild (not left stale)", () => {
    const sqlite = store.connection.sqlite;
    store.record(
      {
        type: "SlackChannelObserved",
        channelId: "C1",
        teamId: "T1",
        displayName: "general",
        kind: "public",
      },
      new Date("2026-07-01T00:00:00.000Z"),
    );
    // A stray row NOT backed by any event must be removed by the truncate+replay.
    sqlite
      .query(
        "INSERT INTO slack_channels (channel_id, team_id, name, kind, observed_at) VALUES ('CSTALE','T1','stale','public','2026-07-01T00:00:00.000Z')",
      )
      .run();
    store.rebuild();
    const rows = sqlite
      .query<{ channel_id: string; name: string }, []>(
        "SELECT channel_id, name FROM slack_channels ORDER BY channel_id",
      )
      .all();
    // Only the event-backed channel survives (stray truncated, event replayed).
    expect(rows).toEqual([{ channel_id: "C1", name: "general" }]);
  });
});

describe("slack_teams rebuild (ADR-0037 §10 / §9, Issue #361)", () => {
  test("slack_teams is truncated + replayed on rebuild (not left stale)", () => {
    const sqlite = store.connection.sqlite;
    store.record(
      { type: "SlackTeamObserved", teamId: "T1", displayName: "Acme" },
      new Date("2026-07-01T00:00:00.000Z"),
    );
    // A stray row NOT backed by any event must be removed by the truncate+replay.
    sqlite
      .query(
        "INSERT INTO slack_teams (team_id, name, observed_at) VALUES ('TSTALE','stale','2026-07-01T00:00:00.000Z')",
      )
      .run();
    store.rebuild();
    const rows = sqlite
      .query<{ team_id: string; name: string }, []>(
        "SELECT team_id, name FROM slack_teams ORDER BY team_id",
      )
      .all();
    // Only the event-backed team survives (stray truncated, event replayed).
    expect(rows).toEqual([{ team_id: "T1", name: "Acme" }]);
  });
});

describe("streaming replay (#498 / ADR-0047 決定 4)", () => {
  test("replays without materializing the log, and reports the streamed count", async () => {
    const { Store } = await import("../../src/db/index.ts");
    const { rebuildProjections } = await import("../../src/projections/rebuild.ts");
    const store = Store.open({ path: ":memory:" });
    try {
      for (let i = 0; i < 200; i++) {
        store.record({
          type: "SourceObserved",
          externalId: `s:${i}`,
          sourceType: "github_issue",
          body: `body ${i}`,
          observedAt: "2026-06-14T00:00:00.000Z",
          fingerprint: `s:${i}`,
          meta: {},
        });
      }
      const result = rebuildProjections(store.connection.sqlite);
      // The count now comes from the stream rather than an array length — a
      // mismatch here would mean replay silently skipped events.
      expect(result.events).toBe(200);
      const rows = store.connection.sqlite
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sources")
        .get();
      expect(rows?.n).toBe(200);
    } finally {
      store.close();
    }
  });

  test("streamAllEvents yields the same events, in the same order, as readAllEvents", async () => {
    const { Store } = await import("../../src/db/index.ts");
    const { readAllEvents, streamAllEvents } = await import("../../src/events/store.ts");
    const store = Store.open({ path: ":memory:" });
    try {
      for (let i = 0; i < 25; i++) {
        store.record({
          type: "SourceObserved",
          externalId: `s:${i}`,
          sourceType: "github_issue",
          body: `body ${i}`,
          observedAt: "2026-06-14T00:00:00.000Z",
          fingerprint: `s:${i}`,
          meta: {},
        });
      }
      const eager = readAllEvents(store.connection.sqlite).map((e) => e.id);
      const streamed = [...streamAllEvents(store.connection.sqlite)].map((e) => e.id);
      // Replay determinism (ADR-0002) depends on order, so this equality is the
      // contract — not merely the same set.
      expect(streamed).toEqual(eager);
    } finally {
      store.close();
    }
  });
});
