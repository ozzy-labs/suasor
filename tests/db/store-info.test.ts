/**
 * `storeInfo` snapshot (Issue #202): event count / projection rows / file size /
 * vec0 / FTS. Drives sources through the event store, then asserts the counts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/db/index.ts";
import { eventTypeBreakdown, formatBytes, storeInfo } from "../../src/db/store-info.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "suasor-store-info-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seed(store: Store, externalId: string, body: string) {
  store.record({
    type: "SourceObserved",
    externalId,
    sourceType: "github_issue",
    body,
    observedAt: "2026-06-14T00:00:00.000Z",
    fingerprint: externalId,
    meta: {},
  });
}

describe("storeInfo", () => {
  test("counts events, projection rows, vec0/meta, and FTS on an on-disk store", () => {
    const dbPath = join(dir, "suasor.db");
    const store = Store.open({ path: dbPath, embeddingDim: 3 });
    try {
      seed(store, "gh:1", "alpha");
      seed(store, "gh:2", "beta");

      const info = storeInfo(store.connection.sqlite, dbPath);
      expect(info.dbPath).toBe(dbPath);
      expect(info.events).toBe(2);
      const sources = info.projections.find((p) => p.table === "sources");
      expect(sources?.rows).toBe(2);
      // FTS is populated by the reducer alongside the source rows.
      expect(info.ftsRows).toBe(2);
      // vec0 / meta tables exist (enableVec default) but no vectors were stored.
      expect(info.vectors).toBe(0);
      expect(info.embeddingsMeta).toBe(0);
      // File size is measured for an on-disk store.
      expect(info.fileSizeBytes).not.toBeNull();
      expect(info.fileSizeBytes ?? 0).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  test("in-memory store reports null file size and dbPath", () => {
    const store = Store.open({ path: ":memory:" });
    try {
      seed(store, "gh:1", "alpha");
      const info = storeInfo(store.connection.sqlite, ":memory:");
      expect(info.dbPath).toBeNull();
      expect(info.fileSizeBytes).toBeNull();
      expect(info.events).toBe(1);
    } finally {
      store.close();
    }
  });

  test("vec0/FTS counts are null when the substrate is absent", () => {
    // Opened without vec: no vec0 / embeddings_meta table.
    const store = Store.open({ path: ":memory:", enableVec: false });
    try {
      const info = storeInfo(store.connection.sqlite, ":memory:");
      expect(info.vectors).toBeNull();
      expect(info.embeddingsMeta).toBeNull();
      // FTS is created by initSchema regardless of vec.
      expect(info.ftsRows).toBe(0);
    } finally {
      store.close();
    }
  });
});

describe("eventTypeBreakdown", () => {
  test("counts events grouped by type, ordered by count desc then type asc", () => {
    const store = Store.open({ path: ":memory:" });
    try {
      // Two SourceObserved + one SourceBodyUpdated on an existing source.
      seed(store, "gh:1", "alpha");
      seed(store, "gh:2", "beta");
      store.record({
        type: "SourceBodyUpdated",
        externalId: "gh:1",
        body: "alpha v2",
        observedAt: "2026-06-15T00:00:00.000Z",
        fingerprint: "gh:1#2",
        meta: {},
      });

      const breakdown = eventTypeBreakdown(store.connection.sqlite);
      expect(breakdown).toEqual([
        { type: "SourceObserved", count: 2 },
        { type: "SourceBodyUpdated", count: 1 },
      ]);
      // Sum of per-type counts equals the total event count.
      const total = breakdown.reduce((acc, e) => acc + e.count, 0);
      expect(total).toBe(storeInfo(store.connection.sqlite, ":memory:").events);
    } finally {
      store.close();
    }
  });

  test("returns an empty array on a fresh store", () => {
    const store = Store.open({ path: ":memory:" });
    try {
      expect(eventTypeBreakdown(store.connection.sqlite)).toEqual([]);
    } finally {
      store.close();
    }
  });
});

describe("formatBytes", () => {
  test("formats across unit boundaries", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0 GB");
  });
});

describe("storeInfo body storage breakdown (#498 / ADR-0047)", () => {
  test("attributes bytes to events, sources and the FTS index", () => {
    const dbPath = join(dir, "suasor.db");
    const store = Store.open({ path: dbPath, embeddingDim: 3 });
    try {
      const body = "x".repeat(5000);
      seed(store, "gh:1", body);

      const info = storeInfo(store.connection.sqlite, dbPath, { embeddingDim: 3 });
      const b = info.bodyStorage;
      // The same body is held twice over: once in the event payload (every
      // version, ADR-0002) and once in the current-row projection.
      expect(b.sourceBodyBytes).toBeGreaterThanOrEqual(body.length);
      expect(b.eventPayloadBytes).toBeGreaterThanOrEqual(body.length);
      // The trigram index is a third copy, and typically the largest.
      expect(b.ftsIndexBytes).not.toBeNull();
      expect(b.ftsIndexBytes ?? 0).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  test("a body updated in place adds a version to events but not to sources", () => {
    const dbPath = join(dir, "suasor.db");
    const store = Store.open({ path: dbPath, embeddingDim: 3 });
    try {
      seed(store, "gh:1", "y".repeat(4000));
      const afterFirst = storeInfo(store.connection.sqlite, dbPath).bodyStorage;
      store.record({
        type: "SourceBodyUpdated",
        externalId: "gh:1",
        body: "z".repeat(4000),
        observedAt: "2026-06-15T00:00:00.000Z",
        fingerprint: "gh:1-v2",
      });
      const afterSecond = storeInfo(store.connection.sqlite, dbPath).bodyStorage;

      // This asymmetry is the whole reason the breakdown exists: history grows
      // with every revision while the projection stays one body wide, so a big
      // store can be mostly versions nobody would miss.
      expect(afterSecond.eventPayloadBytes).toBeGreaterThan(afterFirst.eventPayloadBytes);
      expect(afterSecond.sourceBodyBytes).toBeCloseTo(afterFirst.sourceBodyBytes, -2);
    } finally {
      store.close();
    }
  });

  test("estimates vector bytes only when a dim is supplied", () => {
    const dbPath = join(dir, "suasor.db");
    const store = Store.open({ path: dbPath, embeddingDim: 3 });
    try {
      seed(store, "gh:1", "alpha");
      expect(storeInfo(store.connection.sqlite, dbPath).bodyStorage.vectorBytesEstimate).toBeNull();
      // 0 vectors × 3 dims × 4 bytes = 0 — measurable, just empty.
      expect(
        storeInfo(store.connection.sqlite, dbPath, { embeddingDim: 3 }).bodyStorage
          .vectorBytesEstimate,
      ).toBe(0);
    } finally {
      store.close();
    }
  });

  test("growth is null until the log spans at least a day", () => {
    const dbPath = join(dir, "suasor.db");
    const store = Store.open({ path: dbPath, embeddingDim: 3 });
    try {
      seed(store, "gh:1", "alpha");
      // Every event was just recorded, so there is no slope to report yet —
      // dividing by ~0 days would print a meaningless spike.
      expect(storeInfo(store.connection.sqlite, dbPath).bytesPerDay).toBeNull();
    } finally {
      store.close();
    }
  });

  test("growth is a real rate once the log has history", () => {
    const dbPath = join(dir, "suasor.db");
    const store = Store.open({ path: dbPath, embeddingDim: 3 });
    try {
      // Back-date the first event by 10 days via the injectable store clock.
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      store.record(
        {
          type: "SourceObserved",
          externalId: "gh:old",
          sourceType: "github_issue",
          body: "old",
          observedAt: "2026-06-01T00:00:00.000Z",
          fingerprint: "gh:old",
          meta: {},
        },
        tenDaysAgo,
      );
      seed(store, "gh:1", "alpha");
      const rate = storeInfo(store.connection.sqlite, dbPath).bytesPerDay;
      expect(rate).not.toBeNull();
      expect(rate ?? 0).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });
});
