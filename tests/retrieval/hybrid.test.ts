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

  test("a limit of 0 yields an empty fused list", () => {
    const fused = fuseRrf([hit("a"), hit("b")], [hit("c")], { limit: 0 });
    expect(fused).toEqual([]);
  });

  test("a limit larger than the fused set returns every hit", () => {
    const fused = fuseRrf([hit("a")], [hit("b")], { limit: 99 });
    expect(ids(fused)).toEqual(["a", "b"]);
  });
});

describe("fuseRrf — embedding-disabled graceful fallback (vec list empty)", () => {
  test("an empty vec list degrades to pure FTS order (FR-RET fallback)", () => {
    // When the embedder is disabled the hybrid path passes an empty vec list;
    // fusion must then be exactly the FTS ranking, never crash or reorder.
    const fts = [hit("a"), hit("b"), hit("c")];
    const fused = fuseRrf(fts, []);
    expect(ids(fused)).toEqual(["a", "b", "c"]);
  });

  test("both lists empty (no embedder, no FTS hit) fuses to nothing without error", () => {
    expect(fuseRrf([], [])).toEqual([]);
  });

  test("FTS-only fusion preserves the representative bodies/scores unchanged", () => {
    const a: SearchHit = { ...hit("a"), body: "lexical a", score: -2.1 };
    const fused = fuseRrf([a], []);
    expect(fused[0]?.body).toBe("lexical a");
    expect(fused[0]?.score).toBe(-2.1);
    expect(fused[0]?.rrfScore).toBeGreaterThan(0);
  });
});

describe("fuseRrf — k sensitivity (rank weighting)", () => {
  test("a smaller k sharpens the top-rank advantage but keeps the same winner", () => {
    const fts = [hit("top"), hit("mid"), hit("low")];
    const sharp = fuseRrf(fts, [], { k: 1 });
    const flat = fuseRrf(fts, [], { k: 1000 });
    // The order is unchanged (single list), but the score gap between rank 0 and
    // rank 1 is larger for the smaller k.
    expect(ids(sharp)).toEqual(["top", "mid", "low"]);
    expect(ids(flat)).toEqual(["top", "mid", "low"]);
    const sharpGap = (sharp[0]?.rrfScore ?? 0) - (sharp[1]?.rrfScore ?? 0);
    const flatGap = (flat[0]?.rrfScore ?? 0) - (flat[1]?.rrfScore ?? 0);
    expect(sharpGap).toBeGreaterThan(flatGap);
  });
});
