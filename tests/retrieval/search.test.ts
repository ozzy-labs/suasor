import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../../src/db/index.ts";
import { buildFtsMatch, searchSources, TRIGRAM_LENGTH } from "../../src/retrieval/index.ts";

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
