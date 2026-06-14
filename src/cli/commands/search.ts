/**
 * `suasor search <query>` — FTS5 keyword search over source bodies.
 *
 * The default retrieval path (ADR-0005 / docs/design/retrieval.md): a trigram
 * FTS5 `MATCH` over the `sources` projection, ranked by bm25. Semantic search
 * (recall.search, ADR-0006) is an optional sidecar layered on later; with the
 * embedding backend disabled the system stays usable via this command.
 *
 * Heavy dependencies (DB layer, config loader) are lazy-imported inside
 * `execute` to keep cold start light (NFR-PRF-1, docs/design/cli.md).
 */
import { Command, Option } from "clipanion";

export class SearchCommand extends Command {
  static override paths = [["search"]];

  static override usage = Command.Usage({
    category: "Retrieval",
    description: "Full-text search over ingested sources (FTS5).",
    details: `
      Runs an FTS5 keyword search over local source bodies, ranked best-match
      first. Japanese/English substrings are captured by the trigram tokenizer
      (queries need at least 3 characters to match a substring). Use --json for
      machine-readable output, or --limit to cap results (default 20).
    `,
    examples: [
      ["Search for a keyword", "suasor search release"],
      ["Top 5 hits as JSON", "suasor search --json --limit 5 deploy"],
    ],
  });

  query = Option.String({ required: true, name: "query" });

  limit = Option.String("--limit", {
    description: "Maximum number of hits to return (default 20).",
  });

  json = Option.Boolean("--json", false, {
    description: "Emit results as JSON instead of a human-readable list.",
  });

  override async execute(): Promise<number> {
    const [{ loadConfig }, { Store }] = await Promise.all([
      import("../../config/index.ts"),
      import("../../db/index.ts"),
    ]);

    let limit: number | undefined;
    if (this.limit !== undefined) {
      const parsed = Number(this.limit);
      if (!Number.isInteger(parsed) || parsed < 1) {
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
      const hits = store.search(this.query, limit === undefined ? undefined : { limit });

      if (this.json) {
        this.context.stdout.write(`${JSON.stringify(hits)}\n`);
        return 0;
      }

      if (hits.length === 0) {
        this.context.stdout.write("No matches.\n");
        return 0;
      }

      for (const hit of hits) {
        const snippet = hit.body.replace(/\s+/g, " ").slice(0, 100);
        this.context.stdout.write(`${hit.externalId}\t[${hit.sourceType}]\t${snippet}\n`);
      }
      return 0;
    } finally {
      store.close();
    }
  }
}
