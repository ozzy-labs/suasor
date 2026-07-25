/**
 * `suasor store retention [--dry-run] [--json]` — apply the body-retention
 * policy (ADR-0047 決定 2, Issue #498).
 *
 * Opt-in by construction: with no `[storage.retention].bodyMaxAgeDays` the
 * command explains that nothing is configured and exits 0 without touching the
 * store. Dropping a body removes it from full-text search permanently, so it
 * must never happen because a default said so.
 *
 * Heavy deps (config loader, DB layer, retention service) are lazy-imported
 * inside `execute` to keep cold start light (NFR-PRF-1).
 */
import { existsSync } from "node:fs";
import { Command, Option } from "clipanion";
import { docsUrl } from "../doc-ref.ts";

export class StoreRetentionCommand extends Command {
  static override paths = [["store", "retention"]];

  static override usage = Command.Usage({
    category: "Maintenance",
    description: "Drop bodies older than the configured retention age (opt-in).",
    details: `
      Applies [storage.retention].bodyMaxAgeDays: the body text of sources
      observed longer ago than that is removed from the event log and the
      projection, and the FTS entry is dropped with it (ADR-0047).

      **Kept**: the source row, its metadata, its provenance links and its
      embedding — so a dropped source is still discoverable ("this existed, on
      this date, from this person"), just no longer readable or full-text
      searchable.

      **Irreversible**: the text is removed from the event log too, so a
      rebuild will not bring it back. Re-ingesting the source from upstream is
      the only way to restore a body. Run --dry-run first.

      With no retention configured this is a no-op that tells you so.
    `,
    examples: [
      ["See what would be dropped", "suasor store retention --dry-run"],
      ["Apply the policy", "suasor store retention"],
      ["Machine-readable", "suasor store retention --json"],
    ],
  });

  dryRun = Option.Boolean("--dry-run", false, {
    description: "Report what would be dropped without writing anything.",
  });

  json = Option.Boolean("--json", false, {
    description: "Emit the result as JSON instead of a human-readable report.",
  });

  override async execute(): Promise<number> {
    const [{ loadConfig }, { Store }, { applyRetention }, { formatBytes }] = await Promise.all([
      import("../../config/index.ts"),
      import("../../db/index.ts"),
      import("../../forget/retention.ts"),
      import("../../db/store-info.ts"),
    ]);

    const config = await loadConfig();
    const maxAge = config.storage.retention.bodyMaxAgeDays;
    if (maxAge === null) {
      // Not an error: retention being off is the intended default, and saying
      // so plainly is more useful than a silent success.
      this.context.stdout.write(
        "retention is not configured — no bodies were dropped.\n" +
          "Set [storage.retention].bodyMaxAgeDays to enable it; see " +
          `${docsUrl("adr/0047-storage-lifecycle.md")}\n`,
      );
      return 0;
    }

    const dbPath = config.storage.dbPath;
    if (dbPath === null || !existsSync(dbPath)) {
      this.context.stderr.write(
        `error: database not found at ${dbPath ?? "(unconfigured)"} (run \`suasor init\`)\n`,
      );
      return 1;
    }

    const store = Store.open({ path: dbPath, embeddingDim: config.embedding.dim });
    try {
      const result = applyRetention(store, { bodyMaxAgeDays: maxAge, dryRun: this.dryRun });
      if (this.json) {
        this.context.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return 0;
      }
      if (result.candidates === 0) {
        this.context.stdout.write(
          `no source bodies older than ${maxAge} day(s) (cutoff ${result.cutoff}).\n`,
        );
        return 0;
      }
      const verb = result.dryRun ? "would drop" : "dropped";
      this.context.stdout.write(
        `${verb} ${result.candidates} source bod${result.candidates === 1 ? "y" : "ies"} ` +
          `older than ${maxAge} day(s), freeing ~${formatBytes(result.bytesFreed)} of body text.\n`,
      );
      this.context.stdout.write(
        "  kept: metadata, provenance links, embeddings (the sources stay discoverable)\n",
      );
      if (result.dryRun) {
        this.context.stdout.write("  (dry run — nothing was written)\n");
      } else {
        this.context.stdout.write(
          "  the text is gone from the event log too; a rebuild will not restore it\n",
        );
      }
      return 0;
    } finally {
      store.close();
    }
  }
}
