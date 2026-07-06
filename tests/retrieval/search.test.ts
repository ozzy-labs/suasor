import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../../src/db/index.ts";
import {
  buildExcerpt,
  buildFtsMatch,
  DEFAULT_EXCERPT_CHARS,
  searchSources,
  TRIGRAM_LENGTH,
} from "../../src/retrieval/index.ts";

/** Code-point length (CJK counts as 1), matching the excerpt's own accounting. */
function cpLen(s: string): number {
  return [...s].length;
}

let store: Store;

beforeEach(() => {
  store = Store.open({ path: ":memory:" });
});

afterEach(() => {
  store.close();
});

/** Seed a source via the event store so FTS is maintained by the reducer. */
function seed(externalId: string, body: string, observedAt: string, sourceType = "github_issue") {
  store.record(
    {
      type: "SourceObserved",
      externalId,
      sourceType,
      body,
      observedAt,
      fingerprint: externalId,
      meta: {},
    },
    new Date(observedAt),
  );
}

function ids(result: { hits: Array<{ externalId: string }> }): string[] {
  return result.hits.map((h) => h.externalId);
}

describe("buildFtsMatch", () => {
  test("quotes each token as a phrase and ANDs them", () => {
    expect(buildFtsMatch("deploy rocket")).toBe('"deploy" "rocket"');
  });

  test("escapes embedded double quotes (no injection / syntax error)", () => {
    expect(buildFtsMatch('say "hi"')).toBe('"say" """hi"""');
  });

  test("collapses surrounding/multiple whitespace", () => {
    expect(buildFtsMatch("  go   home  ")).toBe('"go" "home"');
  });

  test("FTS operators inside a token are treated as literal text", () => {
    // `OR` / `*` / `-` must not act as FTS5 syntax once quoted.
    expect(buildFtsMatch("foo OR bar*")).toBe('"foo" "OR" "bar*"');
  });
});

describe("searchSources — English (FTS)", () => {
  test("returns matching sources via the fts strategy", () => {
    seed("a", "the quick brown fox jumps over the lazy dog", "2026-06-14T00:00:00.000Z");
    seed("b", "deploy the rocket to mars next week", "2026-06-14T00:01:00.000Z");

    const result = searchSources(store.connection.sqlite, "rocket");
    expect(result.strategy).toBe("fts");
    expect(ids(result)).toEqual(["b"]);
  });

  test("multi-term query ANDs the terms", () => {
    seed("a", "deploy the rocket", "2026-06-14T00:00:00.000Z");
    seed("b", "rocket science is fun", "2026-06-14T00:01:00.000Z");

    const result = searchSources(store.connection.sqlite, "deploy rocket");
    expect(ids(result)).toEqual(["a"]); // only "a" has both terms
  });
});

describe("searchSources — Japanese (trigram)", () => {
  test("matches a Japanese substring without a word segmenter", () => {
    seed("a", "ロケットを来週デプロイする計画について", "2026-06-14T00:00:00.000Z");
    seed("b", "東京で会議を開催する予定です", "2026-06-14T00:01:00.000Z");

    const result = searchSources(store.connection.sqlite, "ロケット");
    expect(result.strategy).toBe("fts");
    expect(ids(result)).toEqual(["a"]);
  });

  test("matches a mid-string Japanese phrase (substring, not prefix)", () => {
    seed("a", "本日の会議は東京オフィスで行います", "2026-06-14T00:00:00.000Z");

    const result = searchSources(store.connection.sqlite, "会議");
    // "会議" is 2 chars -> trigram cannot index it -> like-fallback handles it.
    expect(result.strategy).toBe("like-fallback");
    expect(ids(result)).toEqual(["a"]);
  });
});

describe("searchSources — ranking order", () => {
  test("more relevant (more frequent) documents rank first", () => {
    seed("few", "rocket science is hard", "2026-06-14T00:00:00.000Z");
    seed("many", "rocket rocket rocket rocket fuel", "2026-06-14T00:01:00.000Z");

    const result = searchSources(store.connection.sqlite, "rocket");
    expect(result.strategy).toBe("fts");
    // bm25 ranks the doc with more "rocket" occurrences higher (first).
    expect(ids(result)).toEqual(["many", "few"]);
    // scores are best-first (ascending bm25 -> first score <= second).
    expect(result.hits[0]?.score).toBeLessThanOrEqual(result.hits[1]?.score ?? 0);
  });
});

describe("searchSources — short-query fallback", () => {
  test("a 2-char ASCII query (too short for trigram) uses LIKE fallback", () => {
    seed("a", "go to the store", "2026-06-14T00:00:00.000Z");
    seed("b", "nothing relevant here", "2026-06-14T00:01:00.000Z");

    const result = searchSources(store.connection.sqlite, "go");
    expect(result.strategy).toBe("like-fallback");
    expect(ids(result)).toEqual(["a"]);
  });

  test("a single Japanese char uses LIKE fallback", () => {
    seed("a", "新宿区の物件", "2026-06-14T00:00:00.000Z");
    seed("b", "渋谷の物件", "2026-06-14T00:01:00.000Z");

    const result = searchSources(store.connection.sqlite, "区");
    expect(result.strategy).toBe("like-fallback");
    expect(ids(result)).toEqual(["a"]);
  });

  test("fallback orders by recency (most recent first)", () => {
    seed("old", "go early", "2026-06-14T00:00:00.000Z");
    seed("new", "go later", "2026-06-15T00:00:00.000Z");

    const result = searchSources(store.connection.sqlite, "go");
    expect(ids(result)).toEqual(["new", "old"]);
  });

  test("the trigram boundary uses FTS at exactly TRIGRAM_LENGTH chars", () => {
    expect(TRIGRAM_LENGTH).toBe(3);
    seed("a", "the foo bar", "2026-06-14T00:00:00.000Z");
    const result = searchSources(store.connection.sqlite, "foo"); // 3 chars
    expect(result.strategy).toBe("fts");
    expect(ids(result)).toEqual(["a"]);
  });

  test("a query is FTS as long as its longest token is long enough", () => {
    seed("a", "go home now", "2026-06-14T00:00:00.000Z");
    // "go" is short but "home" qualifies -> FTS path. (Trigram drops the short
    // "go" phrase, so the match is effectively on "home".)
    const result = searchSources(store.connection.sqlite, "go home");
    expect(result.strategy).toBe("fts");
    expect(ids(result)).toEqual(["a"]);
  });
});

describe("searchSources — empty results", () => {
  test("a query with no matches returns an empty hit list", () => {
    seed("a", "deploy the rocket", "2026-06-14T00:00:00.000Z");
    const result = searchSources(store.connection.sqlite, "submarine");
    expect(result.hits).toHaveLength(0);
  });

  test("an empty query returns no hits without error", () => {
    seed("a", "deploy the rocket", "2026-06-14T00:00:00.000Z");
    expect(searchSources(store.connection.sqlite, "").hits).toHaveLength(0);
    expect(searchSources(store.connection.sqlite, "   ").hits).toHaveLength(0);
  });

  test("a short query with no substring match returns no hits (fallback)", () => {
    seed("a", "deploy the rocket", "2026-06-14T00:00:00.000Z");
    const result = searchSources(store.connection.sqlite, "zz");
    expect(result.strategy).toBe("like-fallback");
    expect(result.hits).toHaveLength(0);
  });
});

describe("searchSources — transparency fields (totalHits / truncated / analyzedQuery)", () => {
  test("a complete (non-truncated) FTS result reports totalHits == hits and truncated false", () => {
    seed("a", "rocket science is hard", "2026-06-14T00:00:00.000Z");
    seed("b", "rocket fuel chemistry", "2026-06-14T00:01:00.000Z");

    const result = searchSources(store.connection.sqlite, "rocket");
    expect(result.hits).toHaveLength(2);
    expect(result.totalHits).toBe(2);
    expect(result.truncated).toBe(false);
  });

  test("a limit-truncated FTS result reports the full totalHits and truncated true", () => {
    for (let i = 0; i < 5; i++) {
      seed(`s${i}`, `rocket number ${i}`, `2026-06-14T00:0${i}:00.000Z`);
    }
    const result = searchSources(store.connection.sqlite, "rocket", { limit: 2 });
    expect(result.hits).toHaveLength(2);
    expect(result.totalHits).toBe(5);
    expect(result.truncated).toBe(true);
  });

  test("a limit-truncated LIKE fallback result also reports the full totalHits", () => {
    for (let i = 0; i < 4; i++) {
      seed(`g${i}`, `go item ${i}`, `2026-06-14T00:0${i}:00.000Z`);
    }
    const result = searchSources(store.connection.sqlite, "go", { limit: 2 });
    expect(result.strategy).toBe("like-fallback");
    expect(result.hits).toHaveLength(2);
    expect(result.totalHits).toBe(4);
    expect(result.truncated).toBe(true);
  });

  test("analyzedQuery is the whitespace-split tokens on the FTS path", () => {
    seed("a", "deploy the rocket", "2026-06-14T00:00:00.000Z");
    const result = searchSources(store.connection.sqlite, "  deploy   rocket ");
    expect(result.analyzedQuery).toEqual(["deploy", "rocket"]);
  });

  test("analyzedQuery is the single trimmed query on the LIKE fallback path", () => {
    seed("a", "go now", "2026-06-14T00:00:00.000Z");
    const result = searchSources(store.connection.sqlite, "  go ");
    expect(result.strategy).toBe("like-fallback");
    expect(result.analyzedQuery).toEqual(["go"]);
  });

  test("an empty query reports empty transparency fields", () => {
    seed("a", "deploy the rocket", "2026-06-14T00:00:00.000Z");
    const result = searchSources(store.connection.sqlite, "   ");
    expect(result.totalHits).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.analyzedQuery).toEqual([]);
  });
});

describe("searchSources — limit & FTS maintenance", () => {
  test("respects the limit option", () => {
    for (let i = 0; i < 5; i++) {
      seed(`s${i}`, `rocket number ${i}`, `2026-06-14T00:0${i}:00.000Z`);
    }
    const result = searchSources(store.connection.sqlite, "rocket", { limit: 2 });
    expect(result.hits).toHaveLength(2);
  });

  test("LIKE fallback wildcards in the query are escaped (treated literally)", () => {
    seed("a", "100% sure", "2026-06-14T00:00:00.000Z");
    seed("b", "abc literal", "2026-06-14T00:01:00.000Z");
    // "%a" must match the literal "%a"? none here -> ensure "%" is not a wildcard.
    const result = searchSources(store.connection.sqlite, "0%");
    expect(result.strategy).toBe("like-fallback");
    expect(ids(result)).toEqual(["a"]); // matches "100% sure", not "abc"
  });

  test("search reflects an updated body after SourceBodyUpdated", () => {
    seed("a", "alpha widget", "2026-06-14T00:00:00.000Z");
    store.record(
      {
        type: "SourceBodyUpdated",
        externalId: "a",
        body: "bravo gadget",
        observedAt: "2026-06-15T00:00:00.000Z",
        fingerprint: "a2",
        meta: {},
      },
      new Date("2026-06-15T00:00:00.000Z"),
    );
    expect(searchSources(store.connection.sqlite, "alpha").hits).toHaveLength(0);
    expect(ids(searchSources(store.connection.sqlite, "gadget"))).toEqual(["a"]);
  });

  test("search reflects rebuild (FTS repopulated from the event log)", () => {
    seed("a", "rebuildable rocket", "2026-06-14T00:00:00.000Z");
    store.rebuild();
    const result = searchSources(store.connection.sqlite, "rocket");
    expect(ids(result)).toEqual(["a"]);
  });
});

describe("searchSources — filters (FTS path)", () => {
  test("sourceType narrows the FTS result set", () => {
    seed("gh", "deploy the rocket", "2026-06-14T00:00:00.000Z", "github_issue");
    seed("sl", "deploy the rocket", "2026-06-14T00:01:00.000Z", "slack_message");

    const result = searchSources(store.connection.sqlite, "rocket", {
      sourceType: "slack_message",
    });
    expect(result.strategy).toBe("fts");
    expect(ids(result)).toEqual(["sl"]);
  });

  test("observedAfter is inclusive on the lower bound", () => {
    seed("before", "rocket alpha", "2026-06-13T23:59:59.000Z");
    seed("at", "rocket bravo", "2026-06-14T00:00:00.000Z");

    const result = searchSources(store.connection.sqlite, "rocket", {
      observedAfter: "2026-06-14T00:00:00.000Z",
    });
    expect(ids(result)).toEqual(["at"]); // the boundary row is included
  });

  test("observedBefore is exclusive on the upper bound", () => {
    seed("in", "rocket alpha", "2026-06-13T00:00:00.000Z");
    seed("at", "rocket bravo", "2026-06-14T00:00:00.000Z");

    const result = searchSources(store.connection.sqlite, "rocket", {
      observedBefore: "2026-06-14T00:00:00.000Z",
    });
    expect(ids(result)).toEqual(["in"]); // the boundary row is excluded
  });

  test("an observed window combines both bounds", () => {
    seed("low", "rocket a", "2026-06-13T00:00:00.000Z");
    seed("mid", "rocket b", "2026-06-14T00:00:00.000Z");
    seed("high", "rocket c", "2026-06-15T00:00:00.000Z");

    const result = searchSources(store.connection.sqlite, "rocket", {
      observedAfter: "2026-06-14T00:00:00.000Z",
      observedBefore: "2026-06-15T00:00:00.000Z",
    });
    expect(ids(result)).toEqual(["mid"]);
  });

  test("no filters returns the same result as before (additive)", () => {
    seed("a", "rocket science", "2026-06-14T00:00:00.000Z");
    seed("b", "lunch menu", "2026-06-14T00:01:00.000Z");
    expect(ids(searchSources(store.connection.sqlite, "rocket"))).toEqual(["a"]);
  });
});

describe("searchSources — ranking determinism & limit boundaries", () => {
  test("repeated identical queries return a stable order (deterministic ranking)", () => {
    seed("a", "rocket rocket fuel", "2026-06-14T00:00:00.000Z");
    seed("b", "rocket science", "2026-06-14T00:01:00.000Z");
    seed("c", "rocket rocket rocket booster", "2026-06-14T00:02:00.000Z");
    const first = ids(searchSources(store.connection.sqlite, "rocket"));
    const second = ids(searchSources(store.connection.sqlite, "rocket"));
    const third = ids(searchSources(store.connection.sqlite, "rocket"));
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  test("limit at exactly the match count is not reported as truncated (boundary)", () => {
    for (let i = 0; i < 3; i++) {
      seed(`s${i}`, `rocket ${i}`, `2026-06-14T00:0${i}:00.000Z`);
    }
    const result = searchSources(store.connection.sqlite, "rocket", { limit: 3 });
    expect(result.hits).toHaveLength(3);
    expect(result.totalHits).toBe(3);
    expect(result.truncated).toBe(false); // 3 hits, limit 3 → full, not truncated
  });

  test("limit one below the match count is truncated with the full totalHits", () => {
    for (let i = 0; i < 3; i++) {
      seed(`s${i}`, `rocket ${i}`, `2026-06-14T00:0${i}:00.000Z`);
    }
    const result = searchSources(store.connection.sqlite, "rocket", { limit: 2 });
    expect(result.hits).toHaveLength(2);
    expect(result.totalHits).toBe(3);
    expect(result.truncated).toBe(true);
  });

  test("a limit of 0 returns no hits but still reports the full totalHits", () => {
    seed("a", "rocket alpha", "2026-06-14T00:00:00.000Z");
    seed("b", "rocket bravo", "2026-06-14T00:01:00.000Z");
    const result = searchSources(store.connection.sqlite, "rocket", { limit: 0 });
    expect(result.hits).toHaveLength(0);
    expect(result.totalHits).toBe(2);
    expect(result.truncated).toBe(true);
  });

  test("all-documents-hit query returns every source (full hit set)", () => {
    seed("a", "common term here", "2026-06-14T00:00:00.000Z");
    seed("b", "the common term again", "2026-06-14T00:01:00.000Z");
    seed("c", "common term in c too", "2026-06-14T00:02:00.000Z");
    const result = searchSources(store.connection.sqlite, "common");
    expect(result.hits).toHaveLength(3);
    expect(result.totalHits).toBe(3);
    expect(new Set(ids(result))).toEqual(new Set(["a", "b", "c"]));
  });

  test("LIKE fallback ties on identical observed_at remain deterministic across runs", () => {
    // Two short-query hits with the same observed_at: the order must be stable so
    // pagination / display does not flicker between calls.
    seed("a", "go a", "2026-06-14T00:00:00.000Z");
    seed("b", "go b", "2026-06-14T00:00:00.000Z");
    const first = ids(searchSources(store.connection.sqlite, "go"));
    const second = ids(searchSources(store.connection.sqlite, "go"));
    expect(first).toHaveLength(2);
    expect(second).toEqual(first);
  });
});

describe("searchSources — short-query fallback: per-token AND (retrieval-2)", () => {
  test("a multi-token short JA query matches docs containing BOTH tokens (not the contiguous substring)", () => {
    // "予算 承認" — both tokens are 2 chars, so this takes the LIKE fallback.
    // Old behavior searched "%予算 承認%" (contiguous, incl. the space) → 0 hits
    // in spaceless Japanese. Per-token AND matches a doc with both tokens.
    seed("both", "来月の予算を承認する会議", "2026-06-14T00:00:00.000Z");
    seed("budget", "予算だけの資料", "2026-06-14T00:01:00.000Z");
    seed("approve", "承認フローの説明", "2026-06-14T00:02:00.000Z");

    const result = searchSources(store.connection.sqlite, "予算 承認");
    expect(result.strategy).toBe("like-fallback");
    expect(ids(result)).toEqual(["both"]); // only the doc with BOTH tokens
  });

  test("analyzedQuery is the per-token split on the fallback path", () => {
    seed("both", "予算と承認", "2026-06-14T00:00:00.000Z");
    const result = searchSources(store.connection.sqlite, "予算 承認");
    expect(result.strategy).toBe("like-fallback");
    expect(result.analyzedQuery).toEqual(["予算", "承認"]);
  });

  test("a token order swap yields the same AND result set", () => {
    seed("both", "承認済みの予算", "2026-06-14T00:00:00.000Z");
    seed("one", "承認のみ", "2026-06-14T00:01:00.000Z");
    expect(ids(searchSources(store.connection.sqlite, "予算 承認"))).toEqual(["both"]);
    expect(ids(searchSources(store.connection.sqlite, "承認 予算"))).toEqual(["both"]);
  });
});

describe("searchSources — short-query fallback: occurrence ranking (retrieval-2)", () => {
  test("a doc with more token occurrences ranks first (crude occurrence count)", () => {
    seed("few", "予算の話", "2026-06-14T00:00:00.000Z"); // 予算 ×1
    seed("many", "予算予算予算の予算会議", "2026-06-14T00:01:00.000Z"); // 予算 ×4

    const result = searchSources(store.connection.sqlite, "予算");
    expect(result.strategy).toBe("like-fallback");
    expect(ids(result)).toEqual(["many", "few"]);
    // score is the occurrence count (higher = more relevant on this path).
    expect(result.hits[0]?.score).toBe(4);
    expect(result.hits[1]?.score).toBe(1);
  });

  test("occurrence count sums across multiple tokens", () => {
    seed("a", "予算 予算 承認", "2026-06-14T00:00:00.000Z"); // 予算×2 + 承認×1 = 3
    const result = searchSources(store.connection.sqlite, "予算 承認");
    expect(result.hits[0]?.score).toBe(3);
  });

  test("ties on occurrence count fall back to recency (most recent first)", () => {
    seed("old", "予算メモ", "2026-06-14T00:00:00.000Z"); // 予算 ×1
    seed("new", "予算資料", "2026-06-15T00:00:00.000Z"); // 予算 ×1
    expect(ids(searchSources(store.connection.sqlite, "予算"))).toEqual(["new", "old"]);
  });

  test("ASCII occurrence counting is case-insensitive (consistent with LIKE)", () => {
    seed("mix", "Go go GO", "2026-06-14T00:00:00.000Z"); // 3 occurrences ignoring case
    const result = searchSources(store.connection.sqlite, "go");
    expect(result.strategy).toBe("like-fallback");
    expect(result.hits[0]?.score).toBe(3);
  });
});

describe("searchSources — bounded excerpt payload (retrieval-m2 / ADR-0018)", () => {
  const longBody = `${"あ".repeat(200)}ロケット${"い".repeat(200)}`;

  test("FTS hits carry a bounded excerpt (not the full body) by default", () => {
    seed("a", longBody, "2026-06-14T00:00:00.000Z");
    const result = searchSources(store.connection.sqlite, "ロケット");
    expect(result.strategy).toBe("fts");
    const hit = result.hits[0];
    expect(hit?.body).toBeUndefined();
    expect(hit?.excerpt).toBeDefined();
    // Bounded to ~DEFAULT_EXCERPT_CHARS (+ up to 2 ellipsis chars).
    expect(cpLen(hit?.excerpt ?? "")).toBeLessThanOrEqual(DEFAULT_EXCERPT_CHARS + 2);
    // Lexical excerpt is centred on the match, so the token is visible.
    expect(hit?.excerpt).toContain("ロケット");
  });

  test("the LIKE fallback carries a bounded excerpt too", () => {
    seed("a", `${"x".repeat(500)}go${"y".repeat(500)}`, "2026-06-14T00:00:00.000Z");
    const result = searchSources(store.connection.sqlite, "go");
    expect(result.strategy).toBe("like-fallback");
    const hit = result.hits[0];
    expect(hit?.body).toBeUndefined();
    expect(cpLen(hit?.excerpt ?? "")).toBeLessThanOrEqual(DEFAULT_EXCERPT_CHARS + 2);
    expect(hit?.excerpt).toContain("go");
  });

  test("fullBody: true returns the full body and omits the excerpt", () => {
    seed("a", longBody, "2026-06-14T00:00:00.000Z");
    const result = searchSources(store.connection.sqlite, "ロケット", { fullBody: true });
    const hit = result.hits[0];
    expect(hit?.excerpt).toBeUndefined();
    expect(hit?.body).toBe(longBody);
  });

  test("maxBodyChars sizes the excerpt", () => {
    seed("a", longBody, "2026-06-14T00:00:00.000Z");
    const result = searchSources(store.connection.sqlite, "ロケット", { maxBodyChars: 20 });
    expect(cpLen(result.hits[0]?.excerpt ?? "")).toBeLessThanOrEqual(20 + 2);
  });

  test("a short body is returned verbatim as the excerpt (no ellipsis)", () => {
    seed("a", "deploy the rocket", "2026-06-14T00:00:00.000Z");
    const result = searchSources(store.connection.sqlite, "rocket");
    expect(result.hits[0]?.excerpt).toBe("deploy the rocket");
  });
});

describe("buildExcerpt", () => {
  test("returns a body already within the budget unchanged", () => {
    expect(buildExcerpt("short body", 240)).toBe("short body");
  });

  test("leading window (no tokens) marks the trailing cut with an ellipsis", () => {
    const body = "0123456789abcdef";
    const ex = buildExcerpt(body, 10);
    expect(ex).toBe("0123456789…");
  });

  test("centres the window on the first matching token", () => {
    const body = `${"a".repeat(100)}TARGET${"b".repeat(100)}`;
    const ex = buildExcerpt(body, 20, ["target"]);
    expect(ex).toContain("TARGET");
    expect(ex.startsWith("…")).toBe(true);
    expect(ex.endsWith("…")).toBe(true);
    expect(cpLen(ex)).toBeLessThanOrEqual(20 + 2);
  });

  test("counts length in code points so CJK counts as one", () => {
    const body = "あ".repeat(300);
    const ex = buildExcerpt(body, 50);
    // 50 kept chars + one trailing ellipsis.
    expect(cpLen(ex)).toBe(51);
  });
});

describe("searchSources — filters (LIKE fallback path)", () => {
  test("sourceType narrows the short-query fallback result set", () => {
    seed("gh", "go now", "2026-06-14T00:00:00.000Z", "github_issue");
    seed("sl", "go now", "2026-06-14T00:01:00.000Z", "slack_message");

    const result = searchSources(store.connection.sqlite, "go", { sourceType: "slack_message" });
    expect(result.strategy).toBe("like-fallback");
    expect(ids(result)).toEqual(["sl"]);
  });

  test("an observed window applies on the fallback path too", () => {
    seed("low", "go a", "2026-06-13T00:00:00.000Z");
    seed("mid", "go b", "2026-06-14T00:00:00.000Z");
    seed("high", "go c", "2026-06-15T00:00:00.000Z");

    const result = searchSources(store.connection.sqlite, "go", {
      observedAfter: "2026-06-14T00:00:00.000Z",
      observedBefore: "2026-06-15T00:00:00.000Z",
    });
    expect(result.strategy).toBe("like-fallback");
    expect(ids(result)).toEqual(["mid"]);
  });
});
