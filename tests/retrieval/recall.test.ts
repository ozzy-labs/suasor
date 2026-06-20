import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../../src/db/index.ts";
import {
  EMBEDDING_DISABLED_SIGNAL,
  type Embedder,
  EmbeddingError,
  embedSources,
  recallSearch,
  upsertSourceVector,
} from "../../src/retrieval/embedding/index.ts";

let store: Store;

beforeEach(() => {
  // Small 3-dim vec0 table so the fixed test vectors below are accepted.
  store = Store.open({ path: ":memory:", embeddingDim: 3 });
});

afterEach(() => {
  store.close();
});

/** Seed a source through the event store so the `sources` projection exists. */
function seed(
  externalId: string,
  body: string,
  opts: { sourceType?: string; observedAt?: string } = {},
) {
  store.record({
    type: "SourceObserved",
    externalId,
    sourceType: opts.sourceType ?? "github_issue",
    body,
    observedAt: opts.observedAt ?? "2026-06-14T00:00:00.000Z",
    fingerprint: externalId,
    meta: {},
  });
}

/**
 * Deterministic fake embedder over a fixed text→vector table. Models share one
 * vector space because the same instance embeds both documents and queries.
 */
function fakeEmbedder(table: Record<string, number[]>, model = "fake-3d"): Embedder {
  return {
    model,
    embed: (texts) => Promise.resolve(texts.map((t) => table[t] ?? [0, 0, 1])),
  };
}

describe("embedSources (vec0 populate on ingest)", () => {
  test("embeds and stores a vector per source, queryable by recall", async () => {
    seed("gh:1", "alpha");
    seed("gh:2", "beta");
    const embedder = fakeEmbedder({ alpha: [1, 0, 0], beta: [0, 1, 0], "find alpha": [1, 0, 0] });

    const result = await embedSources(store.connection.sqlite, embedder, [
      { externalId: "gh:1", body: "alpha" },
      { externalId: "gh:2", body: "beta" },
    ]);
    expect(result.embedded).toBe(2);
    expect(result.error).toBeUndefined();

    const recall = await recallSearch(store.connection.sqlite, embedder, "find alpha");
    expect(recall.hits[0]?.externalId).toBe("gh:1");
  });

  test("empty source list embeds nothing (no sidecar call)", async () => {
    let called = false;
    const embedder: Embedder = {
      model: "x",
      embed: () => {
        called = true;
        return Promise.resolve([]);
      },
    };
    const result = await embedSources(store.connection.sqlite, embedder, []);
    expect(result.embedded).toBe(0);
    expect(called).toBe(false);
  });

  test("a sidecar failure is reported, not thrown (best-effort populate)", async () => {
    seed("gh:1", "alpha");
    const failing: Embedder = {
      model: "x",
      embed: () => Promise.reject(new EmbeddingError("down")),
    };
    const result = await embedSources(store.connection.sqlite, failing, [
      { externalId: "gh:1", body: "alpha" },
    ]);
    expect(result.embedded).toBe(0);
    expect(result.error).toBeInstanceOf(EmbeddingError);
  });

  test("re-embedding a source upserts (replaces) rather than duplicates its vector", async () => {
    seed("gh:1", "alpha");
    const embedder = fakeEmbedder({ alpha: [1, 0, 0], beta: [0, 1, 0], q: [0, 1, 0] });
    await embedSources(store.connection.sqlite, embedder, [{ externalId: "gh:1", body: "alpha" }]);
    // Body changed → re-embed with a different vector.
    await embedSources(store.connection.sqlite, embedder, [{ externalId: "gh:1", body: "beta" }]);

    const sqlite = store.connection.sqlite;
    const count = sqlite
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM embeddings_vec_default WHERE external_id = ?",
      )
      .get("gh:1");
    expect(count?.n).toBe(1);

    // The query [0,1,0] now matches the updated vector.
    const recall = await recallSearch(sqlite, embedder, "q");
    expect(recall.hits[0]?.externalId).toBe("gh:1");
    expect(recall.hits[0]?.score).toBe(0); // exact L2 distance match
  });
});

describe("recallSearch", () => {
  test("returns nearest-neighbour hits best-first (smallest distance)", async () => {
    seed("gh:1", "kubernetes deployment");
    seed("gh:2", "lunch menu");
    const embedder = fakeEmbedder({
      "kubernetes deployment": [1, 0, 0],
      "lunch menu": [0, 1, 0],
      "deploy cluster": [0.9, 0.1, 0],
    });
    await embedSources(store.connection.sqlite, embedder, [
      { externalId: "gh:1", body: "kubernetes deployment" },
      { externalId: "gh:2", body: "lunch menu" },
    ]);

    const result = await recallSearch(store.connection.sqlite, embedder, "deploy cluster");
    expect(result.reason).toBe("ok");
    expect(result.signal).toBeUndefined();
    expect(result.hits.map((h) => h.externalId)).toEqual(["gh:1", "gh:2"]);
    // best-first: distances ascending
    expect(result.hits[0]?.score ?? 1).toBeLessThan(result.hits[1]?.score ?? 0);
  });

  test("honours the limit (k nearest neighbours)", async () => {
    for (let i = 0; i < 5; i++) seed(`gh:${i}`, `s${i}`);
    const embedder = fakeEmbedder({
      s0: [1, 0, 0],
      s1: [0.9, 0, 0],
      s2: [0.8, 0, 0],
      s3: [0.1, 1, 0],
      s4: [0, 1, 0],
      q: [1, 0, 0],
    });
    await embedSources(
      store.connection.sqlite,
      embedder,
      [0, 1, 2, 3, 4].map((i) => ({ externalId: `gh:${i}`, body: `s${i}` })),
    );
    const result = await recallSearch(store.connection.sqlite, embedder, "q", { limit: 2 });
    expect(result.hits).toHaveLength(2);
    expect(result.hits.map((h) => h.externalId)).toEqual(["gh:0", "gh:1"]);
  });

  test("degrades to embedding_disabled signal when the embedder is null", async () => {
    seed("gh:1", "alpha");
    const result = await recallSearch(store.connection.sqlite, null, "alpha");
    expect(result.hits).toEqual([]);
    expect(result.signal).toBe(EMBEDDING_DISABLED_SIGNAL);
    expect(result.reason).toBe("backend_disabled");
  });

  test("an empty/whitespace query returns no hits without a sidecar call", async () => {
    let called = false;
    const embedder: Embedder = {
      model: "x",
      embed: () => {
        called = true;
        return Promise.resolve([[1]]);
      },
    };
    const result = await recallSearch(store.connection.sqlite, embedder, "   ");
    expect(result.hits).toEqual([]);
    expect(result.reason).toBe("ok");
    expect(called).toBe(false);
  });

  test("propagates an EmbeddingError when the query embedding fails", async () => {
    seed("gh:1", "alpha");
    const failing: Embedder = {
      model: "x",
      embed: () => Promise.reject(new EmbeddingError("down")),
    };
    await expect(recallSearch(store.connection.sqlite, failing, "alpha")).rejects.toBeInstanceOf(
      EmbeddingError,
    );
  });

  test("only returns sources that still exist in the projection (JOIN filters orphans)", async () => {
    // Vector present but no backing `sources` row → excluded by the JOIN.
    upsertSourceVector(store.connection.sqlite, "ghost", [1, 0, 0]);
    const embedder = fakeEmbedder({ q: [1, 0, 0] });
    const result = await recallSearch(store.connection.sqlite, embedder, "q");
    expect(result.hits).toEqual([]);
  });
});

describe("recallSearch — metadata filters (post-filter on the join)", () => {
  test("sourceType narrows the KNN result set", async () => {
    seed("gh:1", "kubernetes deployment", { sourceType: "github_issue" });
    seed("sl:1", "kubernetes deployment", { sourceType: "slack_message" });
    const embedder = fakeEmbedder({
      "kubernetes deployment": [1, 0, 0],
      "deploy cluster": [1, 0, 0],
    });
    await embedSources(store.connection.sqlite, embedder, [
      { externalId: "gh:1", body: "kubernetes deployment" },
      { externalId: "sl:1", body: "kubernetes deployment" },
    ]);

    const result = await recallSearch(store.connection.sqlite, embedder, "deploy cluster", {
      sourceType: "slack_message",
    });
    expect(result.hits.map((h) => h.externalId)).toEqual(["sl:1"]);
  });

  test("an observed window filters by inclusive-lower / exclusive-upper bounds", async () => {
    seed("low", "alpha", { observedAt: "2026-06-13T00:00:00.000Z" });
    seed("mid", "alpha", { observedAt: "2026-06-14T00:00:00.000Z" });
    seed("high", "alpha", { observedAt: "2026-06-15T00:00:00.000Z" });
    const embedder = fakeEmbedder({ alpha: [1, 0, 0], q: [1, 0, 0] });
    await embedSources(
      store.connection.sqlite,
      embedder,
      ["low", "mid", "high"].map((id) => ({ externalId: id, body: "alpha" })),
    );

    const result = await recallSearch(store.connection.sqlite, embedder, "q", {
      observedAfter: "2026-06-14T00:00:00.000Z",
      observedBefore: "2026-06-15T00:00:00.000Z",
    });
    expect(result.hits.map((h) => h.externalId)).toEqual(["mid"]);
  });
});

describe("vector-space integrity (same model for ingest and query)", () => {
  test("document and query embeddings share the embedder.model", async () => {
    seed("gh:1", "alpha");
    const embedder = fakeEmbedder({ alpha: [1, 0, 0], "find alpha": [1, 0, 0] }, "bge-m3");
    await embedSources(store.connection.sqlite, embedder, [{ externalId: "gh:1", body: "alpha" }]);
    const result = await recallSearch(store.connection.sqlite, embedder, "find alpha");
    // Same embedder instance ⇒ same model ⇒ comparable vectors ⇒ exact match.
    expect(embedder.model).toBe("bge-m3");
    expect(result.hits[0]?.externalId).toBe("gh:1");
    expect(result.hits[0]?.score).toBe(0);
  });
});
