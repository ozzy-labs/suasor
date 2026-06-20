import { describe, expect, test } from "bun:test";
import { DEFAULT_RRF_K, fuseRrf, type SearchHit } from "../../src/retrieval/index.ts";

/** Build a minimal SearchHit; only externalId matters for fusion ordering. */
function hit(externalId: string, score = 0): SearchHit {
  return {
    externalId,
    sourceType: "github_issue",
    observedAt: "2026-06-14T00:00:00.000Z",
    score,
    body: externalId,
  };
}

function ids(hits: { externalId: string }[]): string[] {
  return hits.map((h) => h.externalId);
}

describe("fuseRrf — single-list passthrough", () => {
  test("FTS-only preserves the FTS order", () => {
    const fts = [hit("a"), hit("b"), hit("c")];
    const fused = fuseRrf(fts, []);
    expect(ids(fused)).toEqual(["a", "b", "c"]);
  });

  test("vec-only preserves the vec order", () => {
    const vec = [hit("x"), hit("y")];
    const fused = fuseRrf([], vec);
    expect(ids(fused)).toEqual(["x", "y"]);
  });

  test("two empty lists fuse to nothing", () => {
    expect(fuseRrf([], [])).toEqual([]);
  });
});

describe("fuseRrf — fusion ordering", () => {
  test("a doc hit by both lists outranks docs hit by only one (all else equal)", () => {
    // `b` is rank 1 in both lists; `a` is rank 0 in FTS only; `c` rank 0 in vec only.
    const fts = [hit("a"), hit("b")];
    const vec = [hit("c"), hit("b")];
    const fused = fuseRrf(fts, vec, { k: DEFAULT_RRF_K });
    // b: 1/(k+1) + 1/(k+1); a: 1/(k+0); c: 1/(k+0). b's sum > either single.
    expect(fused[0]?.externalId).toBe("b");
  });

  test("higher combined rank wins over a single top-rank hit", () => {
    // top1 is FTS rank0 only. shared is FTS rank1 + vec rank0.
    const fts = [hit("top1"), hit("shared")];
    const vec = [hit("shared")];
    const fused = fuseRrf(fts, vec);
    // shared: 1/(k+1) + 1/(k+0); top1: 1/(k+0). shared > top1.
    expect(fused[0]?.externalId).toBe("shared");
  });

  test("rrfScore is attached and the list is best-first (descending)", () => {
    const fts = [hit("a"), hit("b"), hit("c")];
    const fused = fuseRrf(fts, []);
    expect(fused[0]?.rrfScore).toBeGreaterThan(fused[1]?.rrfScore ?? 0);
    expect(fused[1]?.rrfScore).toBeGreaterThan(fused[2]?.rrfScore ?? 0);
  });

  test("ties break by externalId ascending (deterministic)", () => {
    // Both rank 0 in their own single list → identical scores.
    const fused = fuseRrf([hit("zeta")], [hit("alpha")]);
    expect(ids(fused)).toEqual(["alpha", "zeta"]);
  });
});

describe("fuseRrf — dedup + representative", () => {
  test("a duplicate externalId across lists yields a single fused entry", () => {
    const fused = fuseRrf([hit("dup")], [hit("dup")]);
    expect(fused).toHaveLength(1);
    expect(fused[0]?.externalId).toBe("dup");
  });

  test("the FTS hit is the representative when a doc is in both lists", () => {
    const ftsHit: SearchHit = { ...hit("dup"), body: "fts body", score: -1.5 };
    const vecHit: SearchHit = { ...hit("dup"), body: "vec body", score: 0.3 };
    const fused = fuseRrf([ftsHit], [vecHit]);
    expect(fused[0]?.body).toBe("fts body");
    expect(fused[0]?.score).toBe(-1.5);
  });
});

describe("fuseRrf — limit", () => {
  test("limit trims the fused tail", () => {
    const fts = [hit("a"), hit("b"), hit("c"), hit("d")];
    const fused = fuseRrf(fts, [], { limit: 2 });
    expect(ids(fused)).toEqual(["a", "b"]);
  });
});
