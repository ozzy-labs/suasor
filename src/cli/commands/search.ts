/**
 * `suasor search <query>` — FTS-first full-text search over ingested sources.
 *
 * The default retrieval path (ADR-0005 / FR-RET-1, docs/design/retrieval.md).
 * Heavy dependencies (DB layer, config loader, search service) are imported
 * lazily inside `execute` so the CLI cold start stays light (NFR-PRF-1,
 * docs/design/cli.md).
 */
import { Command, Option } from "clipanion";

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
    `,
    examples: [
      ["Search for a keyword", "suasor search rocket"],
      ["Search a Japanese phrase", "suasor search ロケット"],
      ["Limit and emit JSON", "suasor search --limit 5 --json deploy"],
    ],
  });

  query = Option.String();

  limit = Option.String("--limit", { description: "Maximum number of hits (default 20)." });

  json = Option.Boolean("--json", false, {
    description: "Emit results as JSON instead of a human-readable list.",
  });

  override async execute(): Promise<number> {
    const [{ loadConfig }, { Store }, { searchSources, DEFAULT_SEARCH_LIMIT }] = await Promise.all([
      import("../../config/index.ts"),
      import("../../db/index.ts"),
      import("../../retrieval/index.ts"),
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

    const config = await loadConfig();
    const dbPath = config.storage.dbPath;
    if (dbPath === null) {
      this.context.stderr.write("error: storage.dbPath is not configured\n");
      return 1;
    }

    const store = Store.open({ path: dbPath });
    try {
      const result = searchSources(store.connection.sqlite, this.query, { limit });

      if (this.json) {
        this.context.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return 0;
      }

      if (result.hits.length === 0) {
        this.context.stdout.write("No results.\n");
        return 0;
      }

      this.context.stdout.write(`${result.hits.length} result(s) [${result.strategy}]:\n`);
      for (const hit of result.hits) {
        const snippet = hit.body.replaceAll(/\s+/g, " ").slice(0, 120);
        this.context.stdout.write(`  ${hit.externalId} (${hit.sourceType})\n    ${snippet}\n`);
      }
      return 0;
    } finally {
      store.close();
    }
  }
}
