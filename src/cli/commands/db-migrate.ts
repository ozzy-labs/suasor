/**
 * `suasor db migrate` — apply the projection (read-model) schema.
 *
 * Opens the configured database, which creates the events table, projection
 * tables, FTS5 index, and (optionally) the vec0 substrate via `IF NOT EXISTS`
 * DDL. Idempotent: re-running on an existing database is a no-op (ADR-0002 —
 * projections are rebuildable, so DDL is additive). Heavy dependencies (DB
 * layer, config loader) are lazy-imported inside `execute` to keep cold start
 * light (NFR-PRF-1, docs/design/cli.md).
 */
import { Command, Option } from "clipanion";

export class DbMigrateCommand extends Command {
  static override paths = [["db", "migrate"]];

  static override usage = Command.Usage({
    category: "Maintenance",
    description: "Apply the projection schema (idempotent).",
    details: `
      Creates the event store, projection tables, and the FTS5 search index if
      they do not already exist. The append-only event log is never modified;
      projections can always be rebuilt with \`suasor projections rebuild\`.
    `,
    examples: [["Apply the projection schema", "suasor db migrate"]],
  });

  vec = Option.Boolean("--vec", true, {
    description: "Create the sqlite-vec substrate (default true; --no-vec to skip).",
  });

  override async execute(): Promise<number> {
    const [{ loadConfig }, { openDatabase }] = await Promise.all([
      import("../../config/index.ts"),
      import("../../db/index.ts"),
    ]);

    const config = await loadConfig();
    const dbPath = config.storage.dbPath;
    if (dbPath === null) {
      this.context.stderr.write("error: storage.dbPath is not configured\n");
      return 1;
    }

    const db = openDatabase({
      path: dbPath,
      enableVec: this.vec,
      embeddingDim: config.embedding.dim,
    });
    try {
      this.context.stdout.write(`Applied projection schema to ${dbPath}.\n`);
      return 0;
    } finally {
      db.close();
    }
  }
}
