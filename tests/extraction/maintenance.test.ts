/**
 * Extraction coverage status (ADR-0024 §6). Drives `extraction_meta` + `sources`
 * through the sync service, then asserts `extractionStatus` counts extracted /
 * stale (version drift) / pending (extractable, never attempted).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  Connector,
  SourceRecord,
  SyncContext,
  SyncResult,
} from "../../src/connectors/contract.ts";
import { syncConnector } from "../../src/connectors/index.ts";
import { Store } from "../../src/db/index.ts";
import {
  type Extractor,
  extractionStatus,
  listPendingExtractions,
} from "../../src/extraction/index.ts";

let store: Store;

beforeEach(() => {
  store = Store.open({ path: ":memory:" });
});

afterEach(() => {
  store.close();
});

function fakeConnector(records: SourceRecord[]): Connector {
  return {
    name: "local",
    sourceType: "local",
    async *sync(_ctx: SyncContext): AsyncIterable<SourceRecord> {
      for (const r of records) yield r;
    },
    finalize: (): SyncResult => ({ cursor: null }),
  };
}

function docRecord(id: string, filename: string, sourceType = "local_file"): SourceRecord {
  return {
    externalId: id,
    sourceType,
    body: filename,
    observedAt: "2026-06-14T00:00:00.000Z",
    meta: { name: filename },
    fingerprint: `fp-${id}`,
    extractable: {
      filename,
      byteSize: 10,
      readBytes: () => Promise.resolve(new TextEncoder().encode("bytes")),
    },
  };
}

function extractor(version: string, table: Record<string, string | null>): Extractor {
  return {
    version,
    extract: (_b, filename) =>
      Promise.resolve(filename in table ? (table[filename] ?? null) : `text:${filename}`),
  };
}

describe("extractionStatus (ADR-0024)", () => {
  test("counts extracted, unsupported, and pending", async () => {
    // d1 extracts; d2 unsupported; d3 ingested with NO extractor → pending.
    await syncConnector(store, fakeConnector([docRecord("d1", "a.docx")]), {
      extractor: extractor("1", { "a.docx": "alpha" }),
    });
    await syncConnector(store, fakeConnector([docRecord("d2", "b.pdf")]), {
      extractor: extractor("1", { "b.pdf": null }),
    });
    await syncConnector(store, fakeConnector([docRecord("d3", "c.pptx")])); // no extractor

    const status = extractionStatus(store.connection.sqlite, {
      backend: "markitdown",
      version: "1",
    });
    expect(status.totals.extracted).toBe(1);
    expect(status.totals.unsupported).toBe(1);
    expect(status.totals.pending).toBe(1); // d3 never attempted
    expect(status.totals.stale).toBe(0);
  });

  test("box_file sources are tracked for pending/extracted (cross-connector base, #241)", async () => {
    // A Box Office file extracts; another is ingested name-only → pending.
    await syncConnector(store, fakeConnector([docRecord("b1", "spec.docx", "box_file")]), {
      extractor: extractor("1", { "spec.docx": "box text" }),
    });
    await syncConnector(store, fakeConnector([docRecord("b2", "deck.pptx", "box_file")])); // no extractor

    const status = extractionStatus(store.connection.sqlite, {
      backend: "markitdown",
      version: "1",
    });
    expect(status.totals.extracted).toBe(1);
    expect(status.totals.pending).toBe(1); // b2 box_file never attempted
    const rows = listPendingExtractions(store.connection.sqlite, { version: "1" });
    expect(rows).toEqual([{ externalId: "b2", name: "deck.pptx", reason: "pending" }]);
  });

  test("google_drive sources are tracked for pending/extracted (Drive API connector, #242)", async () => {
    // A Drive Office file extracts; another is ingested name-only → pending.
    await syncConnector(store, fakeConnector([docRecord("g1", "spec.docx", "google_drive")]), {
      extractor: extractor("1", { "spec.docx": "drive text" }),
    });
    await syncConnector(store, fakeConnector([docRecord("g2", "deck.pptx", "google_drive")])); // no extractor

    const status = extractionStatus(store.connection.sqlite, {
      backend: "markitdown",
      version: "1",
    });
    expect(status.totals.extracted).toBe(1);
    expect(status.totals.pending).toBe(1); // g2 google_drive never attempted
    const rows = listPendingExtractions(store.connection.sqlite, { version: "1" });
    expect(rows).toEqual([{ externalId: "g2", name: "deck.pptx", reason: "pending" }]);
  });

  test("a recorded version different from the current counts as stale", async () => {
    await syncConnector(store, fakeConnector([docRecord("d1", "a.docx")]), {
      extractor: extractor("1", { "a.docx": "alpha" }),
    });
    // Current config is now version 2 → the d1 meta (v1) is stale.
    const status = extractionStatus(store.connection.sqlite, {
      backend: "markitdown",
      version: "2",
    });
    expect(status.totals.stale).toBe(1);
    expect(status.totals.extracted).toBe(0);
  });
});

describe("listPendingExtractions (Issue #202 drilldown)", () => {
  test("lists pending (never attempted) and stale (version drift) sources", async () => {
    // d1 extracted at v1; d3 ingested name-only (no extractor) → pending.
    await syncConnector(store, fakeConnector([docRecord("d1", "a.docx")]), {
      extractor: extractor("1", { "a.docx": "alpha" }),
    });
    await syncConnector(store, fakeConnector([docRecord("d3", "c.pptx")])); // no extractor

    // Current config is now v2: d1 (recorded v1) is stale, d3 is pending.
    const rows = listPendingExtractions(store.connection.sqlite, { version: "2" });
    expect(rows).toHaveLength(2);
    // pending first, then stale (each group ordered by external_id).
    expect(rows[0]).toEqual({ externalId: "d3", name: "c.pptx", reason: "pending" });
    expect(rows[1]).toEqual({ externalId: "d1", name: "a.docx", reason: "stale" });
  });

  test("settled store at the current version returns nothing", async () => {
    await syncConnector(store, fakeConnector([docRecord("d1", "a.docx")]), {
      extractor: extractor("1", { "a.docx": "alpha" }),
    });
    expect(listPendingExtractions(store.connection.sqlite, { version: "1" })).toEqual([]);
  });

  test("limit caps the listing", async () => {
    await syncConnector(
      store,
      fakeConnector([docRecord("d1", "a.docx"), docRecord("d2", "b.pdf")]),
    ); // both name-only → pending
    const rows = listPendingExtractions(store.connection.sqlite, { version: "1" }, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.externalId).toBe("d1");
  });
});

describe("syncConnector — extraction drift re-extraction (ADR-0024 §6)", () => {
  test("re-extracts an unchanged file when the extractor version bumps", async () => {
    const rec = () => docRecord("d1", "a.docx");
    await syncConnector(store, fakeConnector([rec()]), {
      extractor: extractor("1", { "a.docx": "v1 text" }),
    });
    const body1 = store.connection.sqlite
      .query<{ body: string }, [string]>("SELECT body FROM sources WHERE external_id = ?")
      .get("d1")?.body;
    expect(body1).toBe("a.docx\n\nv1 text");

    // Same file (same fingerprint), newer extractor version + better output.
    const out = await syncConnector(store, fakeConnector([rec()]), {
      extractor: extractor("2", { "a.docx": "v2 better text" }),
    });
    expect(out.extracted).toBe(1); // drift re-extracted despite unchanged fingerprint
    const body2 = store.connection.sqlite
      .query<{ body: string }, [string]>("SELECT body FROM sources WHERE external_id = ?")
      .get("d1")?.body;
    expect(body2).toBe("a.docx\n\nv2 better text");
  });

  test("backfills a name-only file when extraction is newly enabled", async () => {
    const rec = () => docRecord("d1", "a.docx");
    await syncConnector(store, fakeConnector([rec()])); // ingested name-only (no extractor)
    expect(
      store.connection.sqlite
        .query<{ body: string }, [string]>("SELECT body FROM sources WHERE external_id = ?")
        .get("d1")?.body,
    ).toBe("a.docx");

    // Now enable extraction: drift (no meta) re-extracts on the next sync.
    const out = await syncConnector(store, fakeConnector([rec()]), {
      extractor: extractor("1", { "a.docx": "now extracted" }),
    });
    expect(out.extracted).toBe(1);
    expect(
      store.connection.sqlite
        .query<{ body: string }, [string]>("SELECT body FROM sources WHERE external_id = ?")
        .get("d1")?.body,
    ).toBe("a.docx\n\nnow extracted");
  });

  test("no drift when version matches: unchanged file is skipped", async () => {
    const rec = () => docRecord("d1", "a.docx");
    const ex = extractor("1", { "a.docx": "text" });
    await syncConnector(store, fakeConnector([rec()]), { extractor: ex });
    const second = await syncConnector(store, fakeConnector([rec()]), { extractor: ex });
    expect(second.unchanged).toBe(1);
    expect(second.extracted).toBe(0);
  });
});
