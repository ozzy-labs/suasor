/**
 * `suasor extraction status [--json]` / `extraction list-pending [--limit N]`
 * — document-extraction coverage + drilldown (ADR-0024, Issue #202).
 *
 * `status` reports the configured backend / version and, from the
 * `extraction_meta` sidecar, how many sources are extracted / unsupported /
 * too-large / stale (version drift → re-extract next sync) / pending
 * (extractable, never attempted). `list-pending` is the drilldown: the actual
 * sources awaiting (re)extraction. Read-only. Heavy deps (config loader, DB
 * layer, maintenance) are lazy-imported inside `execute` (NFR-PRF-1).
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

export class ExtractionListPendingCommand extends Command {
  static override paths = [["extraction", "list-pending"]];

  static override usage = Command.Usage({
    category: "Maintenance",
    description: "List sources awaiting (re)extraction (pending / stale).",
    details: `
      Drilldown behind the pending / stale roll-ups of \`extraction status\`
      (Issue #202): lists the actual local_file sources awaiting (re)extraction.
      \`pending\` rows are extractable but never attempted; \`stale\` rows were
      extracted under a different version (drift). Run \`suasor local sync\` to
      backfill them. Use --limit to cap the listing (default 50).
    `,
    examples: [
      ["List pending extractions", "suasor extraction list-pending"],
      ["Cap the listing", "suasor extraction list-pending --limit 10"],
      ["Machine-readable", "suasor extraction list-pending --json"],
    ],
  });

  limit = Option.String("--limit", {
    description: "Maximum sources to list (positive integer; default 50).",
  });

  json = Option.Boolean("--json", false, {
    description: "Emit the pending-source list as JSON.",
  });

  override async execute(): Promise<number> {
    let limit = 50;
    if (this.limit !== undefined) {
      const parsed = Number(this.limit);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        this.context.stderr.write("error: --limit must be a positive integer\n");
        return 1;
      }
      limit = parsed;
    }

    const [{ loadConfig }, { Store }, { listPendingExtractions }] = await Promise.all([
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
      const rows = listPendingExtractions(
        store.connection.sqlite,
        { version: config.extraction.version },
        limit,
      );
      if (this.json) {
        this.context.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
        return 0;
      }
      if (rows.length === 0) {
        this.context.stdout.write("No sources awaiting (re)extraction.\n");
        return 0;
      }
      this.context.stdout.write(`${rows.length} source(s) awaiting (re)extraction:\n`);
      for (const r of rows) {
        this.context.stdout.write(`  [${r.reason}] ${r.name}  ${r.externalId}\n`);
      }
      if (config.extraction.backend === "disabled") {
        this.context.stdout.write(
          "  backend disabled — set [extraction].backend to extract (see docs/guide/extraction.md)\n",
        );
      } else {
        this.context.stdout.write("  run `suasor local sync` to (re)extract these sources\n");
      }
      return 0;
    } finally {
      store.close();
    }
  }
}
