/**
 * Query layer for `source.get.full` + `activity.timeline` (Issue #279).
 *
 * - getSourceFull bundles source.get + graph.related(out) + extraction_meta.
 * - buildActivityTimeline merges the source/task/decision entities provenance-
 *   connected to an origin entity, time-ordered newest-first, windowed + capped.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../../src/db/index.ts";
import {
  buildActivityTimeline,
  getExtractionMeta,
  getSourceFull,
  type SourceRecord,
  type TaskRecord,
} from "../../src/mcp/queries.ts";

let store: Store;

beforeEach(() => {
  store = Store.open({ path: ":memory:" });
});

afterEach(() => {
  store.close();
});

const sqlite = () => store.connection.sqlite;

function source(externalId: string, observedAt: string, sourceType = "github_issue") {
  store.record({
    type: "SourceObserved",
    externalId,
    sourceType,
    body: `body of ${externalId}`,
    observedAt,
    fingerprint: externalId,
    meta: {},
  });
}

/** Seed an extraction_meta sidecar row (derived substrate, not an event — ADR-0024). */
function extractionMeta(externalId: string, version: string, state: string) {
  sqlite()
    .query(
      "INSERT INTO extraction_meta (external_id, version, state, updated_at) VALUES (?, ?, ?, ?)",
    )
    .run(externalId, version, state, "2026-06-14T00:00:00.000Z");
}

describe("getSourceFull (#279)", () => {
  test("bundles source body + outgoing links + extraction_meta", () => {
    source("s1", "2026-06-10T00:00:00.000Z");
    // A task derived_from s1 creates an INCOMING link to the source (task → source);
    // a manual link source → decision creates an OUTGOING link from the source.
    store.record({
      type: "TaskProposed",
      taskId: "t1",
      title: "do it",
      sourceExternalIds: ["s1"],
    });
    store.record({
      type: "LinkAdded",
      linkId: "ln1",
      fromKind: "source",
      fromId: "s1",
      toKind: "decision",
      toId: "d1",
    });
    extractionMeta("s1", "v1", "extracted");

    const full = getSourceFull(sqlite(), "s1");
    expect(full.source?.externalId).toBe("s1");
    expect(full.source?.body).toBe("body of s1");
    // Only the OUTGOING edge (source → decision) is bundled (direction=out).
    expect(full.links).toHaveLength(1);
    expect(full.links[0]).toMatchObject({ kind: "decision", id: "d1", direction: "out" });
    expect(full.extractionMeta).toEqual({
      version: "v1",
      state: "extracted",
      updatedAt: "2026-06-14T00:00:00.000Z",
    });
  });

  test("unknown id returns source:null, empty links, null extraction_meta", () => {
    const full = getSourceFull(sqlite(), "missing");
    expect(full.source).toBeNull();
    expect(full.links).toEqual([]);
    expect(full.extractionMeta).toBeNull();
  });

  test("a source with no extraction sidecar returns extractionMeta:null", () => {
    source("plain", "2026-06-10T00:00:00.000Z");
    const full = getSourceFull(sqlite(), "plain");
    expect(full.source?.externalId).toBe("plain");
    expect(full.extractionMeta).toBeNull();
    expect(getExtractionMeta(sqlite(), "plain")).toBeNull();
  });
});

describe("buildActivityTimeline (#279)", () => {
  test("merges connected source/task/decision items newest-first", () => {
    source("s1", "2026-06-10T00:00:00.000Z");
    // task derived_from s1 (updated_at = recordedAt of the apply); decision too.
    store.record({
      type: "TaskProposed",
      taskId: "t1",
      title: "task one",
      sourceExternalIds: ["s1"],
    });
    store.record({
      type: "DecisionRecorded",
      decisionId: "d1",
      title: "decided",
      rationale: "",
      sourceExternalIds: ["s1"],
    });

    // Centre on the source: it reaches t1 + d1 via the provenance graph.
    const timeline = buildActivityTimeline(sqlite(), "source", "s1");
    expect(timeline.origin).toEqual({ kind: "source", id: "s1" });
    const kinds = timeline.items.map((i) => i.kind).sort();
    expect(kinds).toEqual(["decision", "source", "task"]);
    // Newest-first by each kind's natural timestamp.
    const ats = timeline.items.map((i) => i.at);
    const sorted = [...ats].sort((a, b) => (a < b ? 1 : -1));
    expect(ats).toEqual(sorted);
  });

  test("respects the time window (after/before) on each item's timestamp", () => {
    source("old", "2026-01-01T00:00:00.000Z");
    source("new", "2026-06-10T00:00:00.000Z");
    // Link both sources to a project entity so the timeline can reach them.
    store.record({
      type: "LinkAdded",
      linkId: "pl1",
      fromKind: "project",
      fromId: "p1",
      toKind: "source",
      toId: "old",
    });
    store.record({
      type: "LinkAdded",
      linkId: "pl2",
      fromKind: "project",
      fromId: "p1",
      toKind: "source",
      toId: "new",
    });

    const all = buildActivityTimeline(sqlite(), "project", "p1");
    expect(all.items.map((i) => i.id).sort()).toEqual(["new", "old"]);

    const windowed = buildActivityTimeline(sqlite(), "project", "p1", {
      window: { after: "2026-03-01T00:00:00.000Z" },
    });
    expect(windowed.items.map((i) => i.id)).toEqual(["new"]);
    expect(windowed.window.since).toBe("2026-03-01T00:00:00.000Z");
  });

  test("caps to limit (newest-first)", () => {
    for (let i = 0; i < 5; i += 1) {
      const day = String(10 + i).padStart(2, "0");
      source(`s${i}`, `2026-06-${day}T00:00:00.000Z`);
      store.record({
        type: "LinkAdded",
        linkId: `l${i}`,
        fromKind: "person",
        fromId: "alice",
        toKind: "source",
        toId: `s${i}`,
      });
    }
    const timeline = buildActivityTimeline(sqlite(), "person", "alice", { limit: 2 });
    expect(timeline.items).toHaveLength(2);
    // The two newest sources (s4 @ 06-14, s3 @ 06-13).
    expect(timeline.items.map((i) => i.id)).toEqual(["s4", "s3"]);
  });

  test("an entity with no connected activity returns an empty timeline", () => {
    const timeline = buildActivityTimeline(sqlite(), "person", "nobody");
    expect(timeline.items).toEqual([]);
    expect(timeline.origin).toEqual({ kind: "person", id: "nobody" });
  });

  test("items carry the full projection record", () => {
    source("s1", "2026-06-10T00:00:00.000Z");
    const timeline = buildActivityTimeline(sqlite(), "source", "s1");
    const item = timeline.items.find((i) => i.kind === "source");
    expect((item?.record as SourceRecord).body).toBe("body of s1");

    store.record({ type: "TaskProposed", taskId: "t1", title: "t", sourceExternalIds: ["s1"] });
    const t = buildActivityTimeline(sqlite(), "source", "s1").items.find((i) => i.kind === "task");
    expect((t?.record as TaskRecord).title).toBe("t");
  });
});
