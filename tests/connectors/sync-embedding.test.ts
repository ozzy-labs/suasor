import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  Connector,
  SourceRecord,
  SyncContext,
  SyncResult,
} from "../../src/connectors/contract.ts";
import { syncConnector } from "../../src/connectors/index.ts";
import { Store } from "../../src/db/index.ts";
import { type Embedder, EmbeddingError, recallSearch } from "../../src/retrieval/embedding/index.ts";

let store: Store;

beforeEach(() => {
  // Small 3-dim vec0 table so the fixed test vectors below are accepted.
  store = Store.open({ path: ":memory:", embeddingDim: 3 });
});

afterEach(() => {
  store.close();
});

function fakeConnector(records: SourceRecord[], name = "fake"): Connector {
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

const rec = (id: string, body: string, fp?: string): SourceRecord => ({
  externalId: id,
  sourceType: "github_issue",
  body,
  observedAt: "2026-06-14T00:00:00.000Z",
  meta: {},
  ...(fp ? { fingerprint: fp } : {}),
});

function fakeEmbedder(table: Record<string, number[]>): Embedder {
  return { model: "fake-3d", embed: (texts) => Promise.resolve(texts.map((t) => table[t] ?? [0, 0, 1])) };
}

function vecCount(externalId: string): number {
  return (
    store.connection.sqlite
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM embeddings_vec_default WHERE external_id = ?",
      )
      .get(externalId)?.n ?? 0
  );
}

describe("syncConnector — embedding population (ADR-0005/0006)", () => {
  test("no embedder ⇒ ingest stays FTS-only (no vectors, embedded=0)", async () => {
    const out = await syncConnector(store, fakeConnector([rec("gh:1", "alpha")]));
    expect(out.observed).toBe(1);
    expect(out.embedded).toBe(0);
    expect(vecCount("gh:1")).toBe(0);
  });

  test("with an embedder, observed sources are embedded into vec0 and recall finds them", async () => {
    const embedder = fakeEmbedder({ alpha: [1, 0, 0], beta: [0, 1, 0], "find alpha": [1, 0, 0] });
    const out = await syncConnector(store, fakeConnector([rec("gh:1", "alpha"), rec("gh:2", "beta")]), {
      embedder,
    });
    expect(out.observed).toBe(2);
    expect(out.embedded).toBe(2);
    expect(vecCount("gh:1")).toBe(1);

    const recall = await recallSearch(store.connection.sqlite, embedder, "find alpha");
    expect(recall.hits[0]?.externalId).toBe("gh:1");
  });

  test("unchanged sources are not re-embedded (embedded=0 on idempotent re-run)", async () => {
    const embedder = fakeEmbedder({ alpha: [1, 0, 0] });
    await syncConnector(store, fakeConnector([rec("gh:1", "alpha")]), { embedder });
    const out = await syncConnector(store, fakeConnector([rec("gh:1", "alpha")]), { embedder });
    expect(out.unchanged).toBe(1);
    expect(out.embedded).toBe(0);
  });

  test("changed bodies are re-embedded (updated source ⇒ embedded counts it)", async () => {
    const embedder = fakeEmbedder({ before: [1, 0, 0], after: [0, 1, 0] });
    await syncConnector(store, fakeConnector([rec("gh:1", "before")]), { embedder });
    const out = await syncConnector(store, fakeConnector([rec("gh:1", "after")]), { embedder });
    expect(out.updated).toBe(1);
    expect(out.embedded).toBe(1);
    expect(vecCount("gh:1")).toBe(1); // upsert, not duplicate
  });

  test("a sidecar failure does not fail ingest; onEmbedError is called (graceful degrade)", async () => {
    const failing: Embedder = {
      model: "x",
      embed: () => Promise.reject(new EmbeddingError("ollama down")),
    };
    let reported: Error | undefined;
    const out = await syncConnector(store, fakeConnector([rec("gh:1", "alpha")]), {
      embedder: failing,
      onEmbedError: (e) => {
        reported = e;
      },
    });
    // Ingest still succeeded (source + FTS written), only embedding was skipped.
    expect(out.observed).toBe(1);
    expect(out.embedded).toBe(0);
    expect(reported).toBeInstanceOf(EmbeddingError);
    const body = store.connection.sqlite
      .query<{ body: string }, [string]>("SELECT body FROM sources WHERE external_id = ?")
      .get("gh:1");
    expect(body?.body).toBe("alpha");
  });
});
