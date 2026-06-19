import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../../src/db/index.ts";
import {
  DEFAULT_DUPLICATE_THRESHOLD,
  type Embedder,
  EmbeddingError,
  embeddingDrain,
  embeddingRebuild,
  embeddingStatus,
  embedSources,
  findDuplicates,
  upsertSourceVector,
} from "../../src/retrieval/embedding/index.ts";

let store: Store;

beforeEach(() => {
  // 3-dim vec0 table so the fixed test vectors below are accepted.
  store = Store.open({ path: ":memory:", embeddingDim: 3 });
});

afterEach(() => {
  store.close();
});

/** Seed a source through the event store so the `sources` projection exists. */
function seed(externalId: string, body: string, sourceType = "github_issue") {
  store.record({
    type: "SourceObserved",
    externalId,
    sourceType,
    body,
    observedAt: "2026-06-14T00:00:00.000Z",
    fingerprint: externalId,
    meta: {},
  });
}

/** Deterministic fake embedder over a fixed text→vector table. */
function fakeEmbedder(
  table: Record<string, number[]>,
  model = "fake-3d",
  modelVersion?: string,
): Embedder {
  return {
    model,
    ...(modelVersion !== undefined ? { modelVersion } : {}),
    embed: (texts) => Promise.resolve(texts.map((t) => table[t] ?? [0, 0, 1])),
  };
}

describe("embeddingStatus", () => {
  test("disabled backend: all sources count as pending, none embedded", () => {
    seed("gh:1", "alpha");
    seed("gh:2", "beta");
    const status = embeddingStatus(store.connection.sqlite, null, "disabled");
    expect(status.backend).toBe("disabled");
    expect(status.modelId).toBeNull();
    expect(status.auto).toBe(false);
    expect(status.totals).toEqual({ total: 2, embedded: 0, pending: 2, stale: 0 });
  });

  test("counts embedded / pending per entity kind for the active model", async () => {
    seed("gh:1", "alpha", "github_issue");
    seed("gh:2", "beta", "github_issue");
    seed("sl:1", "gamma", "slack_message");
    const embedder = fakeEmbedder({ alpha: [1, 0, 0], gamma: [0, 1, 0] });
    // Embed one github_issue and the slack_message; gh:2 stays pending.
    await embedSources(store.connection.sqlite, embedder, [
      { externalId: "gh:1", body: "alpha" },
      { externalId: "sl:1", body: "gamma" },
    ]);

    const status = embeddingStatus(store.connection.sqlite, embedder, "ollama");
    expect(status.auto).toBe(true);
    expect(status.modelId).toBe("fake-3d");
    const byKind = Object.fromEntries(status.kinds.map((k) => [k.sourceType, k]));
    expect(byKind.github_issue).toMatchObject({ total: 2, embedded: 1, pending: 1, stale: 0 });
    expect(byKind.slack_message).toMatchObject({ total: 1, embedded: 1, pending: 0, stale: 0 });
    expect(status.totals).toEqual({ total: 3, embedded: 2, pending: 1, stale: 0 });
  });

  test("a vector from a different model counts as stale, not embedded", async () => {
    seed("gh:1", "alpha");
    const oldModel = fakeEmbedder({ alpha: [1, 0, 0] }, "old-model");
    await embedSources(store.connection.sqlite, oldModel, [{ externalId: "gh:1", body: "alpha" }]);

    const newModel = fakeEmbedder({ alpha: [1, 0, 0] }, "new-model");
    const status = embeddingStatus(store.connection.sqlite, newModel, "ollama");
    expect(status.totals).toEqual({ total: 1, embedded: 0, pending: 0, stale: 1 });
  });

  test("a model version bump (same id) is detected as stale", async () => {
    seed("gh:1", "alpha");
    const v1 = fakeEmbedder({ alpha: [1, 0, 0] }, "bge-m3", "v1");
    await embedSources(store.connection.sqlite, v1, [{ externalId: "gh:1", body: "alpha" }]);
    const v2 = fakeEmbedder({ alpha: [1, 0, 0] }, "bge-m3", "v2");
    const status = embeddingStatus(store.connection.sqlite, v2, "ollama");
    expect(status.totals.stale).toBe(1);
    expect(status.totals.embedded).toBe(0);
  });
});

describe("embeddingRebuild", () => {
  test("re-embeds only drifted/missing sources by default (idempotent when settled)", async () => {
    seed("gh:1", "alpha");
    seed("gh:2", "beta");
    const embedder = fakeEmbedder({ alpha: [1, 0, 0], beta: [0, 1, 0] });
    // gh:1 already embedded; gh:2 pending.
    await embedSources(store.connection.sqlite, embedder, [{ externalId: "gh:1", body: "alpha" }]);

    const first = await embeddingRebuild(store.connection.sqlite, embedder);
    // Only gh:2 (missing) is a candidate.
    expect(first.candidates).toBe(1);
    expect(first.embedded).toBe(1);

    // Now everything is current → a second rebuild is a no-op.
    const second = await embeddingRebuild(store.connection.sqlite, embedder);
    expect(second.candidates).toBe(0);
    expect(second.embedded).toBe(0);
  });

  test("--full re-embeds every source regardless of recorded model", async () => {
    seed("gh:1", "alpha");
    seed("gh:2", "beta");
    const embedder = fakeEmbedder({ alpha: [1, 0, 0], beta: [0, 1, 0] });
    await embedSources(store.connection.sqlite, embedder, [
      { externalId: "gh:1", body: "alpha" },
      { externalId: "gh:2", body: "beta" },
    ]);
    const result = await embeddingRebuild(store.connection.sqlite, embedder, { full: true });
    expect(result.candidates).toBe(2);
    expect(result.embedded).toBe(2);
  });

  test("after a model swap, default rebuild re-embeds the stale sources", async () => {
    seed("gh:1", "alpha");
    const oldModel = fakeEmbedder({ alpha: [1, 0, 0] }, "old");
    await embedSources(store.connection.sqlite, oldModel, [{ externalId: "gh:1", body: "alpha" }]);
    const newModel = fakeEmbedder({ alpha: [1, 0, 0] }, "new");

    const result = await embeddingRebuild(store.connection.sqlite, newModel);
    expect(result.embedded).toBe(1);
    const status = embeddingStatus(store.connection.sqlite, newModel, "ollama");
    expect(status.totals).toEqual({ total: 1, embedded: 1, pending: 0, stale: 0 });
  });

  test("a sidecar failure is reported with a partial count, not thrown", async () => {
    seed("gh:1", "alpha");
    const failing: Embedder = {
      model: "x",
      embed: () => Promise.reject(new EmbeddingError("down")),
    };
    const result = await embeddingRebuild(store.connection.sqlite, failing, { full: true });
    expect(result.embedded).toBe(0);
    expect(result.error).toBeInstanceOf(EmbeddingError);
  });
});

describe("embeddingDrain", () => {
  test("embeds only sources with no vector yet (pending catch-up)", async () => {
    seed("gh:1", "alpha");
    seed("gh:2", "beta");
    const embedder = fakeEmbedder({ alpha: [1, 0, 0], beta: [0, 1, 0] });
    await embedSources(store.connection.sqlite, embedder, [{ externalId: "gh:1", body: "alpha" }]);

    const result = await embeddingDrain(store.connection.sqlite, embedder);
    expect(result.candidates).toBe(1); // only gh:2 pending
    expect(result.embedded).toBe(1);

    const status = embeddingStatus(store.connection.sqlite, embedder, "ollama");
    expect(status.totals.pending).toBe(0);
  });

  test("does not touch stale-but-present vectors (those are rebuild's job)", async () => {
    seed("gh:1", "alpha");
    const oldModel = fakeEmbedder({ alpha: [1, 0, 0] }, "old");
    await embedSources(store.connection.sqlite, oldModel, [{ externalId: "gh:1", body: "alpha" }]);
    const newModel = fakeEmbedder({ alpha: [1, 0, 0] }, "new");
    const result = await embeddingDrain(store.connection.sqlite, newModel);
    expect(result.candidates).toBe(0); // gh:1 has a (stale) vector → not pending
  });
});

describe("findDuplicates", () => {
  test("lists near-duplicate pairs above the threshold, best-first", async () => {
    seed("gh:1", "alpha");
    seed("gh:2", "alpha-dup");
    seed("gh:3", "orthogonal");
    const embedder = fakeEmbedder({
      alpha: [1, 0, 0],
      "alpha-dup": [0.99, 0.01, 0], // ~ identical direction to gh:1
      orthogonal: [0, 1, 0],
    });
    await embedSources(store.connection.sqlite, embedder, [
      { externalId: "gh:1", body: "alpha" },
      { externalId: "gh:2", body: "alpha-dup" },
      { externalId: "gh:3", body: "orthogonal" },
    ]);

    const dups = findDuplicates(store.connection.sqlite, 0.95);
    expect(dups).toHaveLength(1);
    expect(dups[0]?.a).toBe("gh:1");
    expect(dups[0]?.b).toBe("gh:2");
    expect(dups[0]?.similarity).toBeGreaterThan(0.95);
  });

  test("threshold boundary: a pair below the cutoff is excluded, above is included", async () => {
    seed("gh:1", "a");
    seed("gh:2", "b");
    const embedder = fakeEmbedder({
      a: [1, 0, 0],
      b: [0.8, 0.6, 0], // cosine = 0.8 (unit vectors)
    });
    await embedSources(store.connection.sqlite, embedder, [
      { externalId: "gh:1", body: "a" },
      { externalId: "gh:2", body: "b" },
    ]);
    // Above the pair similarity → excluded.
    expect(findDuplicates(store.connection.sqlite, 0.9)).toHaveLength(0);
    // Below the pair similarity → included; similarity ~0.8.
    const below = findDuplicates(store.connection.sqlite, 0.75);
    expect(below).toHaveLength(1);
    expect(below[0]?.similarity).toBeCloseTo(0.8, 4);
  });

  test("uses the default threshold when none is given", async () => {
    seed("gh:1", "a");
    seed("gh:2", "b");
    const embedder = fakeEmbedder({ a: [1, 0, 0], b: [0, 1, 0] });
    await embedSources(store.connection.sqlite, embedder, [
      { externalId: "gh:1", body: "a" },
      { externalId: "gh:2", body: "b" },
    ]);
    expect(DEFAULT_DUPLICATE_THRESHOLD).toBe(0.95);
    expect(findDuplicates(store.connection.sqlite)).toHaveLength(0);
  });

  test("ignores vectors whose source no longer exists (JOIN drops orphans)", () => {
    upsertSourceVector(store.connection.sqlite, "ghost-1", [1, 0, 0], { modelId: "fake-3d" });
    upsertSourceVector(store.connection.sqlite, "ghost-2", [1, 0, 0], { modelId: "fake-3d" });
    expect(findDuplicates(store.connection.sqlite, 0.5)).toHaveLength(0);
  });
});
