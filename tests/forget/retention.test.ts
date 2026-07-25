/**
 * Body retention (ADR-0047 決定 2, Issue #498).
 *
 * The properties that matter are what retention *keeps*, not just what it
 * removes: dropping a body must leave the source discoverable (metadata, links,
 * embedding) and must say so explicitly, because an empty body that looks like
 * "this source had no text" is exactly the silent wrong answer ADR-0007 forbids.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../../src/db/index.ts";
import { applyRetention } from "../../src/forget/retention.ts";
import { getSource, listSources } from "../../src/mcp/queries.ts";

let store: Store;
const NOW = new Date("2026-07-25T00:00:00.000Z");

beforeEach(() => {
  store = Store.open({ path: ":memory:" });
});

afterEach(() => {
  store.close();
});

function seed(externalId: string, observedAt: string, body = "confidential paragraph") {
  store.record({
    type: "SourceObserved",
    externalId,
    sourceType: "slack_message",
    body,
    observedAt,
    fingerprint: externalId,
    meta: { channel: "C1" },
  });
}

/** Body text still present in the event log for a source. */
function eventBodies(externalId: string): string[] {
  return store.connection.sqlite
    .query<{ body: string }, [string]>(
      `SELECT json_extract(payload, '$.body') AS body
         FROM events
        WHERE type IN ('SourceObserved','SourceBodyUpdated')
          AND json_extract(payload, '$.externalId') = ?`,
    )
    .all(externalId)
    .map((r) => r.body);
}

describe("applyRetention", () => {
  test("drops bodies older than the cutoff and leaves newer ones alone", () => {
    seed("old", "2026-01-01T00:00:00.000Z");
    seed("recent", "2026-07-20T00:00:00.000Z");

    const result = applyRetention(store, { bodyMaxAgeDays: 90 }, NOW);
    expect(result.dropped).toBe(1);
    expect(result.bytesFreed).toBeGreaterThan(0);

    expect(getSource(store.connection.sqlite, "old")?.body).toBe("");
    expect(getSource(store.connection.sqlite, "recent")?.body).toBe("confidential paragraph");
  });

  test("keeps the source discoverable — metadata and observed_at survive", () => {
    seed("old", "2026-01-01T00:00:00.000Z");
    applyRetention(store, { bodyMaxAgeDays: 90 }, NOW);

    const row = getSource(store.connection.sqlite, "old");
    // Deleting the row would leave a hole in the history; retention bounds
    // storage without erasing the record that something existed.
    expect(row).not.toBeNull();
    expect(row?.observedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(row?.meta.channel).toBe("C1");
    expect(row?.sourceType).toBe("slack_message");
  });

  test("says the body was dropped rather than returning a bare empty string", () => {
    seed("old", "2026-01-01T00:00:00.000Z");
    seed("empty-by-nature", "2026-07-20T00:00:00.000Z", "");
    applyRetention(store, { bodyMaxAgeDays: 90 }, NOW);

    // Both bodies read as "", so without the marker a caller cannot tell
    // "removed to bound storage" from "this source genuinely has no text".
    expect(getSource(store.connection.sqlite, "old")?.bodyDroppedAt).not.toBeNull();
    expect(getSource(store.connection.sqlite, "empty-by-nature")?.bodyDroppedAt).toBeNull();
  });

  test("removes the text from the event log too (a rebuild cannot restore it)", async () => {
    seed("old", "2026-01-01T00:00:00.000Z");
    store.record({
      type: "SourceBodyUpdated",
      externalId: "old",
      body: "second version, also confidential",
      observedAt: "2026-01-02T00:00:00.000Z",
      fingerprint: "old-v2",
    });
    applyRetention(store, { bodyMaxAgeDays: 90 }, NOW);

    // Every version, not just the current one — otherwise nothing is reclaimed
    // and the text comes back on the next rebuild.
    expect(eventBodies("old")).toEqual(["", ""]);

    const { rebuildProjections } = await import("../../src/projections/rebuild.ts");
    rebuildProjections(store.connection.sqlite);
    const row = getSource(store.connection.sqlite, "old");
    expect(row?.body).toBe("");
    // Replay-stable: the drop marker is reproduced from the audit event.
    expect(row?.bodyDroppedAt).not.toBeNull();
  });

  test("drops the FTS entry so search cannot match unshowable text", () => {
    seed("old", "2026-01-01T00:00:00.000Z", "kubernetes rollout notes");
    const hitsBefore = store.connection.sqlite
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sources_fts WHERE external_id = 'old'")
      .get();
    expect(hitsBefore?.n).toBe(1);

    applyRetention(store, { bodyMaxAgeDays: 90 }, NOW);
    const hitsAfter = store.connection.sqlite
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sources_fts WHERE external_id = 'old'")
      .get();
    expect(hitsAfter?.n).toBe(0);
  });

  test("--dry-run reports the candidates but writes nothing", () => {
    seed("old", "2026-01-01T00:00:00.000Z");
    const result = applyRetention(store, { bodyMaxAgeDays: 90, dryRun: true }, NOW);
    expect(result.candidates).toBe(1);
    expect(result.dropped).toBe(0);
    expect(result.bytesFreed).toBeGreaterThan(0);
    expect(getSource(store.connection.sqlite, "old")?.body).toBe("confidential paragraph");
  });

  test("is idempotent — a second pass finds nothing to do", () => {
    seed("old", "2026-01-01T00:00:00.000Z");
    expect(applyRetention(store, { bodyMaxAgeDays: 90 }, NOW).dropped).toBe(1);
    const second = applyRetention(store, { bodyMaxAgeDays: 90 }, NOW);
    expect(second.candidates).toBe(0);
    expect(second.dropped).toBe(0);
  });

  test("an empty store (or an all-recent one) is a clean no-op", () => {
    seed("recent", "2026-07-24T00:00:00.000Z");
    const result = applyRetention(store, { bodyMaxAgeDays: 90 }, NOW);
    expect(result.candidates).toBe(0);
    expect(result.dropped).toBe(0);
    expect(listSources(store.connection.sqlite)).toHaveLength(1);
  });

  test("keeps the embedding sidecar (a dropped body stays semantically findable)", async () => {
    const vecStore = Store.open({ path: ":memory:", embeddingDim: 3 });
    try {
      vecStore.record({
        type: "SourceObserved",
        externalId: "old",
        sourceType: "slack_message",
        body: "kubernetes rollout notes",
        observedAt: "2026-01-01T00:00:00.000Z",
        fingerprint: "old",
        meta: {},
      });
      const { upsertSourceVector } = await import("../../src/retrieval/embedding/recall.ts");
      upsertSourceVector(vecStore.connection.sqlite, "old", [0, 0, 1]);

      applyRetention(vecStore, { bodyMaxAgeDays: 90 }, NOW);

      // ADR-0047 keeps vectors deliberately: they are small, and they are what
      // still surfaces "this existed" after the text is gone. (The resulting
      // "found it but cannot read it" state is why the marker above exists.)
      const { DEFAULT_VEC_TABLE } = await import("../../src/db/connection.ts");
      const vectors = vecStore.connection.sqlite
        .query<{ n: number }, []>(
          `SELECT COUNT(*) AS n FROM ${DEFAULT_VEC_TABLE} WHERE external_id = 'old'`,
        )
        .get();
      expect(vectors?.n).toBe(1);
    } finally {
      vecStore.close();
    }
  });
});
