import { describe, expect, test } from "bun:test";
import { Store } from "../../src/db/index.ts";

/** Open an in-memory store seeded with the given source bodies. */
function seeded(bodies: Array<{ externalId: string; sourceType: string; body: string }>): Store {
  const store = Store.open({ path: ":memory:" });
  let i = 0;
  for (const s of bodies) {
    i += 1;
    store.record({
      type: "SourceObserved",
      externalId: s.externalId,
      sourceType: s.sourceType,
      body: s.body,
      observedAt: "2026-06-14T00:00:00.000Z",
      fingerprint: `fp${i}`,
      meta: {},
    });
  }
  return store;
}

describe("Store.search (FTS5)", () => {
  test("returns matching sources for a keyword", () => {
    const store = seeded([
      { externalId: "gh:1", sourceType: "github_issue", body: "deploy the release pipeline" },
      { externalId: "gh:2", sourceType: "github_issue", body: "unrelated note about lunch" },
    ]);
    try {
      const hits = store.search("release");
      expect(hits.map((h) => h.externalId)).toEqual(["gh:1"]);
      expect(hits[0]?.sourceType).toBe("github_issue");
      expect(hits[0]?.body).toContain("release");
    } finally {
      store.close();
    }
  });

  test("matches Japanese substrings via the trigram tokenizer", () => {
    // The trigram tokenizer indexes 3-grams, so substring queries need >= 3
    // characters (a property of FTS5 'trigram', not of this query layer).
    const store = seeded([
      { externalId: "sl:1", sourceType: "slack_message", body: "来週の会議の準備をする" },
      { externalId: "sl:2", sourceType: "slack_message", body: "昼食の予定だけ" },
    ]);
    try {
      const hits = store.search("の会議");
      expect(hits.map((h) => h.externalId)).toEqual(["sl:1"]);
    } finally {
      store.close();
    }
  });

  test("returns an empty array for a blank query (no FTS error)", () => {
    const store = seeded([{ externalId: "gh:1", sourceType: "github_issue", body: "anything" }]);
    try {
      expect(store.search("")).toEqual([]);
      expect(store.search("   ")).toEqual([]);
    } finally {
      store.close();
    }
  });

  test("honours the limit option (clamped to >= 1)", () => {
    const store = seeded([
      { externalId: "a", sourceType: "note", body: "alpha shared term" },
      { externalId: "b", sourceType: "note", body: "beta shared term" },
      { externalId: "c", sourceType: "note", body: "gamma shared term" },
    ]);
    try {
      expect(store.search("shared", { limit: 2 })).toHaveLength(2);
      expect(store.search("shared", { limit: 0 })).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("reflects the latest body after a SourceBodyUpdated", () => {
    const store = Store.open({ path: ":memory:" });
    try {
      store.record({
        type: "SourceObserved",
        externalId: "gh:9",
        sourceType: "github_issue",
        body: "original keyword apple",
        observedAt: "2026-06-14T00:00:00.000Z",
        fingerprint: "fp1",
        meta: {},
      });
      store.record({
        type: "SourceBodyUpdated",
        externalId: "gh:9",
        body: "revised keyword banana",
        observedAt: "2026-06-14T01:00:00.000Z",
        fingerprint: "fp2",
        meta: {},
      });
      expect(store.search("apple")).toHaveLength(0);
      expect(store.search("banana").map((h) => h.externalId)).toEqual(["gh:9"]);
    } finally {
      store.close();
    }
  });
});
