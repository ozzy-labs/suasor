/**
 * `storeInfo` snapshot (Issue #202): event count / projection rows / file size /
 * vec0 / FTS. Drives sources through the event store, then asserts the counts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/db/index.ts";
import { formatBytes, storeInfo } from "../../src/db/store-info.ts";

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

describe("formatBytes", () => {
  test("formats across unit boundaries", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0 GB");
  });
});
