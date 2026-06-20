/**
 * `suasor extraction status [--json]` — document-extraction coverage (ADR-0024).
 *
 * Reports the configured backend / version and, from the `extraction_meta`
 * sidecar, how many sources are extracted / unsupported / too-large / stale
 * (version drift → re-extract next sync) / pending (extractable, never
 * attempted). Read-only. Heavy deps (config loader, DB layer, maintenance) are
 * lazy-imported inside `execute` to keep cold start light (NFR-PRF-1).
 */
import { Command, Option } from "clipanion";

export class ExtractionStatusCommand extends Command {
  static override paths = [["extraction", "status"]];

  static override usage = Command.Usage({
    category: "Maintenance",
    description: "Show document-extraction coverage (extracted / stale / pending).",
    details: `
      Reports the active [extraction] backend / version and per-state counts from
      the extraction_meta sidecar (ADR-0024): extracted, unsupported, too-large,
      stale (recorded version differs → re-extracted on the next sync), and
      pending (extractable sources never attempted, e.g. extraction newly
      enabled — run \`suasor local sync\` to backfill). Use --json for machine output.
    `,
    examples: [
      ["Human-readable coverage", "suasor extraction status"],
      ["Machine-readable", "suasor extraction status --json"],
    ],
  });

  json = Option.Boolean("--json", false, {
    description: "Emit the status snapshot as JSON instead of a table.",
  });

  override async execute(): Promise<number> {
    const [{ loadConfig }, { Store }, { extractionStatus }] = await Promise.all([
      import("../../config/index.ts"),
      import("../../db/index.ts"),
      import("../../extraction/index.ts"),
    ]);

    const config = await loadConfig();
    const dbPath = config.storage.dbPath;
    if (dbPath === null) {
      this.context.stderr.write("error: storage.dbPath is not configured\n");
      return 1;
    }

    const store = Store.open({ path: dbPath, embeddingDim: config.embedding.dim });
    try {
      const status = extractionStatus(store.connection.sqlite, {
        backend: config.extraction.backend,
        version: config.extraction.version,
      });

      if (this.json) {
        this.context.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
        return 0;
      }

      const t = status.totals;
      this.context.stdout.write(
        `extraction: backend=${status.backend} version=${status.version}\n`,
      );
      this.context.stdout.write(
        `  extracted: ${t.extracted}  stale: ${t.stale}  pending: ${t.pending}  ` +
          `unsupported: ${t.unsupported}  too-large: ${t.tooLarge}\n`,
      );
      if (status.backend === "disabled") {
        this.context.stdout.write(
          "  backend disabled — Office/PDF stay name-only (set [extraction].backend; see docs/guide/extraction.md)\n",
        );
      } else if (t.pending > 0 || t.stale > 0) {
        this.context.stdout.write(
          "  run `suasor local sync` to (re)extract pending / stale sources\n",
        );
      }
      return 0;
    } finally {
      store.close();
    }
  }
}
