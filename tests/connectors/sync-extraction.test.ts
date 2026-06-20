/**
 * Document-extraction wiring in the sync service (ADR-0024 PR 2/4). A record
 * carrying an `extractable` handle has its body replaced with sidecar-extracted
 * text for new/changed records when an extractor is supplied — best-effort:
 * unsupported / oversized / failing inputs degrade to the name-only body.
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
import type { Extractor } from "../../src/extraction/index.ts";
import { ExtractionError } from "../../src/extraction/index.ts";

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
    finalize(): SyncResult {
      return { cursor: null };
    },
  };
}

/** A name-only Office record with an extractable handle (lazy bytes). */
function docRecord(
  id: string,
  filename: string,
  bytes: string,
  opts: { fp?: string; byteSize?: number } = {},
): SourceRecord {
  return {
    externalId: id,
    sourceType: "local_file",
    body: filename, // name-only until extracted
    observedAt: "2026-06-14T00:00:00.000Z",
    meta: { path: `/docs/${filename}`, name: filename },
    fingerprint: opts.fp ?? `fp-${id}`,
    extractable: {
      filename,
      byteSize: opts.byteSize ?? bytes.length,
      readBytes: () => Promise.resolve(new TextEncoder().encode(bytes)),
    },
  };
}

/** Extractor that returns text from a table; `null` ⇒ unsupported. */
function fakeExtractor(table: Record<string, string | null>): Extractor {
  return {
    extract: (_bytes, filename) =>
      Promise.resolve(filename in table ? (table[filename] ?? null) : `extracted:${filename}`),
  };
}

function bodyOf(externalId: string): string | undefined {
  return (
    store.connection.sqlite
      .query<{ body: string }, [string]>("SELECT body FROM sources WHERE external_id = ?")
      .get(externalId)?.body ?? undefined
  );
}

describe("syncConnector — extraction (ADR-0024)", () => {
  test("replaces the body with extracted text and counts it", async () => {
    const out = await syncConnector(
      store,
      fakeConnector([docRecord("d1", "spec.docx", "ZIPBYTES")]),
      {
        extractor: fakeExtractor({ "spec.docx": "# Spec\n\ncontent" }),
      },
    );
    expect(out.observed).toBe(1);
    expect(out.extracted).toBe(1);
    // Body keeps the filename for discoverability, then the extracted text.
    expect(bodyOf("d1")).toBe("spec.docx\n\n# Spec\n\ncontent");
  });

  test("without an extractor the body stays name-only (extracted=0)", async () => {
    const out = await syncConnector(store, fakeConnector([docRecord("d1", "spec.docx", "B")]));
    expect(out.extracted).toBe(0);
    expect(bodyOf("d1")).toBe("spec.docx");
  });

  test("unsupported format (extract → null) degrades to name-only", async () => {
    const out = await syncConnector(store, fakeConnector([docRecord("d1", "image.heic", "B")]), {
      extractor: fakeExtractor({ "image.heic": null }),
    });
    expect(out.extracted).toBe(0);
    expect(bodyOf("d1")).toBe("image.heic");
  });

  test("oversized input is skipped (name-only) and warns", async () => {
    const warnings: string[] = [];
    const out = await syncConnector(
      store,
      fakeConnector([docRecord("d1", "huge.pdf", "B", { byteSize: 10_000 })]),
      {
        extractor: fakeExtractor({ "huge.pdf": "should not be used" }),
        extractionMaxBytes: 100,
        onWarn: (m) => warnings.push(m),
      },
    );
    expect(out.extracted).toBe(0);
    expect(bodyOf("d1")).toBe("huge.pdf");
    expect(warnings.some((w) => w.includes("huge.pdf"))).toBe(true);
  });

  test("extractor failure degrades to name-only and reports via onExtractError", async () => {
    const errors: Error[] = [];
    const failing: Extractor = {
      extract: () => Promise.reject(new ExtractionError("sidecar down")),
    };
    const out = await syncConnector(store, fakeConnector([docRecord("d1", "spec.docx", "B")]), {
      extractor: failing,
      onExtractError: (e) => errors.push(e),
    });
    expect(out.extracted).toBe(0);
    expect(bodyOf("d1")).toBe("spec.docx");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(ExtractionError);
  });

  test("caps extracted text at extractionMaxBytes", async () => {
    const out = await syncConnector(store, fakeConnector([docRecord("d1", "big.pdf", "B")]), {
      extractor: fakeExtractor({ "big.pdf": "x".repeat(500) }),
      extractionMaxBytes: 50,
    });
    expect(out.extracted).toBe(1);
    // filename + "\n\n" + 50 capped chars.
    expect(bodyOf("d1")).toBe(`big.pdf\n\n${"x".repeat(50)}`);
  });

  test("unchanged records are not re-extracted (readBytes not called)", async () => {
    let reads = 0;
    const mk = (): SourceRecord => ({
      externalId: "d1",
      sourceType: "local_file",
      body: "spec.docx",
      observedAt: "2026-06-14T00:00:00.000Z",
      meta: { name: "spec.docx" },
      fingerprint: "stable",
      extractable: {
        filename: "spec.docx",
        byteSize: 1,
        readBytes: () => {
          reads += 1;
          return Promise.resolve(new TextEncoder().encode("B"));
        },
      },
    });
    const ex = fakeExtractor({ "spec.docx": "content" });
    await syncConnector(store, fakeConnector([mk()]), { extractor: ex });
    const second = await syncConnector(store, fakeConnector([mk()]), { extractor: ex });
    expect(second.unchanged).toBe(1);
    expect(second.extracted).toBe(0);
    expect(reads).toBe(1); // only the first (new) sync read bytes
  });
});
