/**
 * `suasor search <query>` — FTS-first full-text search over ingested sources.
 *
 * The default retrieval path (ADR-0005 / FR-RET-1, docs/design/retrieval.md).
 * Heavy dependencies (DB layer, config loader, search service) are imported
 * lazily inside `execute` so the CLI cold start stays light (NFR-PRF-1,
 * docs/design/cli.md).
 */
import { Command, Option } from "clipanion";
import { resolveSince, SINCE_SYNTAX_HINT } from "../../shared/since.ts";

export class SearchCommand extends Command {
  static override paths = [["search"]];

  static override usage = Command.Usage({
    category: "Retrieval",
    description: "Full-text search over ingested sources (FTS5, FTS-first).",
    details: `
      Searches source bodies via the SQLite FTS5 (trigram) index and prints
      ranked hits (ADR-0005 / FR-RET-1). Japanese and English are handled
      uniformly; queries too short for the trigram index fall back to a
      substring scan. Use --json for machine-readable output.

      The query is matched as literal text: FTS5 operators (AND/OR/NOT, *, "",
      parentheses, NEAR) are NOT interpreted — every token is searched verbatim.

      Filters narrow the result set (both the FTS and the short-query fallback
      path) without changing ranking:

      - --source-type <type>      restrict to one source_type (e.g. github_issue)
      - --since <dur|iso>         inclusive lower bound on observed_at (>=):
                                  relative (24h / 7d / 2w) or ISO date
                                  (alias: --observed-after)
      - --until <dur|iso>         exclusive upper bound on observed_at (<):
                                  relative (24h / 7d / 2w) or ISO date
                                  (alias: --observed-before)

      The human output annotates the strategy used ([fts] or [like-fallback]);
      --json additionally reports totalHits / truncated / analyzedQuery so a
      caller can tell a complete result set from a limit-truncated one.

      Each hit carries a bounded excerpt (not the full body) by default so a
      multi-hit result stays small; fetch full text via source.get / source list.
      Use --full-body to include the full body per hit, or --max-body-chars N to
      size the excerpt.
    `,
    examples: [
      ["Search for a keyword", "suasor search rocket"],
      ["Search a Japanese phrase", "suasor search ロケット"],
      ["Limit and emit JSON", "suasor search --limit 5 --json deploy"],
      ["Restrict to one source type", "suasor search --source-type github_issue rocket"],
      ["Include the full body per hit", "suasor search --full-body rocket"],
      ["Restrict to the last week", "suasor search --since 7d rocket"],
      [
        "Restrict to an observed window",
        "suasor search --since 2026-06-01T00:00:00Z --until 2026-07-01T00:00:00Z rocket",
      ],
    ],
  });

  query = Option.String();

  limit = Option.String("--limit", { description: "Maximum number of hits (default 20)." });

  sourceType = Option.String("--source-type", {
    description: "Restrict to a single source_type (e.g. github_issue).",
  });

  since = Option.String("--since,--observed-after", {
    description: "Inclusive lower bound on observed_at (>=): relative (24h / 7d / 2w) or ISO date.",
  });

  until = Option.String("--until,--observed-before", {
    description: "Exclusive upper bound on observed_at (<): relative (24h / 7d / 2w) or ISO date.",
  });

  fullBody = Option.Boolean("--full-body", false, {
    description: "Return each hit's full body instead of a bounded excerpt (default: excerpt).",
  });

  maxBodyChars = Option.String("--max-body-chars", {
    description: "Max characters per excerpt (default 240).",
  });

  json = Option.Boolean("--json", false, {
    description: "Emit results as JSON instead of a human-readable list.",
  });

  override async execute(): Promise<number> {
    const [
      { loadConfig },
      { Store },
      { searchSources, DEFAULT_SEARCH_LIMIT },
      { emitEmbeddingDisabledHint },
    ] = await Promise.all([
      import("../../config/index.ts"),
      import("../../db/index.ts"),
      import("../../retrieval/index.ts"),
      import("../embedding-hint.ts"),
    ]);

    let limit = DEFAULT_SEARCH_LIMIT;
    if (this.limit !== undefined) {
      const parsed = Number(this.limit);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        this.context.stderr.write("error: --limit must be a positive integer\n");
        return 1;
      }
      limit = parsed;
    }

    let maxBodyChars: number | undefined;
    if (this.maxBodyChars !== undefined) {
      const parsed = Number(this.maxBodyChars);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        this.context.stderr.write("error: --max-body-chars must be a positive integer\n");
        return 1;
      }
      maxBodyChars = parsed;
    }

    // Resolve the time filters through the shared duration/ISO parser and
    // reject unparseable values (Issue #561): raw strings would be compared
    // lexicographically against observed_at and silently match nothing
    // (ADR-0007 "no silent wrong answer").
    const now = Date.now();
    let observedAfter: string | undefined;
    if (this.since !== undefined) {
      const resolved = resolveSince(this.since, now);
      if (resolved === null) {
        this.context.stderr.write(`error: --since must be ${SINCE_SYNTAX_HINT}\n`);
        return 1;
      }
      observedAfter = resolved;
    }
    let observedBefore: string | undefined;
    if (this.until !== undefined) {
      const resolved = resolveSince(this.until, now);
      if (resolved === null) {
        this.context.stderr.write(`error: --until must be ${SINCE_SYNTAX_HINT}\n`);
        return 1;
      }
      observedBefore = resolved;
    }

    const config = await loadConfig();
    const dbPath = config.storage.dbPath;
    if (dbPath === null) {
      this.context.stderr.write("error: storage.dbPath is not configured\n");
      return 1;
    }

    // FTS-first retrieval works without embeddings, but when the backend is
    // disabled semantic recall is off — surface that on stderr so a thin result
    // set has a visible cause (Issue #159). Suppressed under --json (pipe-clean).
    emitEmbeddingDisabledHint(this.context.stderr, config.embedding.backend, this.json);

    const store = Store.open({ path: dbPath, embeddingDim: config.embedding.dim });
    try {
      const result = searchSources(store.connection.sqlite, this.query, {
        limit,
        ...(this.sourceType !== undefined ? { sourceType: this.sourceType } : {}),
        ...(observedAfter !== undefined ? { observedAfter } : {}),
        ...(observedBefore !== undefined ? { observedBefore } : {}),
        ...(this.fullBody ? { fullBody: true } : {}),
        ...(maxBodyChars !== undefined ? { maxBodyChars } : {}),
      });

      if (this.json) {
        this.context.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return 0;
      }

      if (result.hits.length === 0) {
        // Annotate the strategy even on the empty path so "no FTS match" and
        // "no fallback match" are distinguishable (ADR-0007 "no silent wrong
        // answer").
        this.context.stdout.write(`No results [${result.strategy}].\n`);
        return 0;
      }

      // Show totalHits when the page was truncated by --limit so the reader
      // knows there are more matches than the ones printed.
      const header = result.truncated
        ? `${result.hits.length} of ${result.totalHits} result(s) [${result.strategy}]:`
        : `${result.hits.length} result(s) [${result.strategy}]:`;
      this.context.stdout.write(`${header}\n`);
      for (const hit of result.hits) {
        // Default hits carry `excerpt`; `--full-body` swaps in the full `body`.
        const text = (hit.body ?? hit.excerpt ?? "").replaceAll(/\s+/g, " ").slice(0, 120);
        this.context.stdout.write(`  ${hit.externalId} (${hit.sourceType})\n    ${text}\n`);
      }
      return 0;
    } finally {
      store.close();
    }
  }
}
