/**
 * `suasor store info [--breakdown] [--json]` — store size / health snapshot
 * (Issue #202; --breakdown event-type histogram, Issue #270).
 *
 * Complements `suasor doctor` (which reports *whether* things are wired) with
 * the *magnitudes* of the local store: event-log size, projection row counts,
 * DB file size on disk, vec0 vector count, and the FTS index scale. Read-only —
 * every query is a COUNT / PRAGMA / stat and it never creates the database
 * (that is `suasor init`'s job). Heavy deps (config loader, DB layer) are
 * lazy-imported inside `execute` to keep cold start light (NFR-PRF-1).
 */
import { existsSync } from "node:fs";
import { Command, Option } from "clipanion";

export class StoreInfoCommand extends Command {
  static override paths = [["store", "info"]];

  static override usage = Command.Usage({
    category: "Maintenance",
    description: "Show store size: events, projection rows, DB file size, vec0, FTS.",
    details: `
      Reports the magnitude of the local store (ADR-0002 / ADR-0005): event-log
      count, per-projection-table row counts, DB file size on disk (incl. WAL),
      vec0 vector count, and the FTS5 index scale. Read-only (never creates the
      database — that is \`suasor init\`'s job). Use --json for machine output.

      With --breakdown, additionally lists the event-log count grouped by event
      type (COUNT(*) GROUP BY type) — useful for rebuild/replay debugging and to
      see the source mix at a glance.
    `,
    examples: [
      ["Human-readable store size", "suasor store info"],
      ["Event-type histogram of the log", "suasor store info --breakdown"],
      ["Machine-readable", "suasor store info --json"],
    ],
  });

  json = Option.Boolean("--json", false, {
    description: "Emit the snapshot as JSON instead of a human-readable report.",
  });

  breakdown = Option.Boolean("--breakdown", false, {
    description: "Also show the event-log count grouped by event type.",
  });

  override async execute(): Promise<number> {
    const [{ loadConfig }, { Store, storeInfo, eventTypeBreakdown, formatBytes }] =
      await Promise.all([import("../../config/index.ts"), import("../../db/index.ts")]);

    const config = await loadConfig();
    const dbPath = config.storage.dbPath;
    if (dbPath === null) {
      this.context.stderr.write("error: storage.dbPath is not configured\n");
      return 1;
    }
    if (!existsSync(dbPath)) {
      this.context.stderr.write(
        `error: database not found at ${dbPath} (run \`suasor init\` or \`suasor db migrate\`)\n`,
      );
      return 1;
    }

    const store = Store.open({ path: dbPath, embeddingDim: config.embedding.dim });
    try {
      const info = storeInfo(store.connection.sqlite, dbPath, {
        embeddingDim: config.embedding.dim,
      });
      const breakdown = this.breakdown ? eventTypeBreakdown(store.connection.sqlite) : undefined;
      if (this.json) {
        const payload = breakdown === undefined ? info : { ...info, eventBreakdown: breakdown };
        this.context.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return 0;
      }

      const size = info.fileSizeBytes === null ? "(in-memory)" : formatBytes(info.fileSizeBytes);
      this.context.stdout.write(`store: ${info.dbPath ?? "(in-memory)"}\n`);
      this.context.stdout.write(`  file size:  ${size}\n`);
      this.context.stdout.write(`  events:     ${info.events}\n`);
      this.context.stdout.write("  projections:\n");
      for (const p of info.projections) {
        this.context.stdout.write(`    ${p.table.padEnd(18)} ${p.rows}\n`);
      }
      const vectors = info.vectors === null ? "(no vec0 table)" : String(info.vectors);
      const meta = info.embeddingsMeta === null ? "(none)" : String(info.embeddingsMeta);
      const fts = info.ftsRows === null ? "(no FTS table)" : String(info.ftsRows);
      this.context.stdout.write(`  vec0:       ${vectors} vector(s), meta rows: ${meta}\n`);
      this.context.stdout.write(`  fts:        ${fts} row(s)\n`);

      // Where the bodies actually are (ADR-0047 決定 1). Without this split, a
      // large store is unattributable: you cannot tell whether it is mostly
      // history, mostly index, or mostly vectors — so you cannot tell what a
      // retention policy would reclaim.
      const b = info.bodyStorage;
      const measured =
        b.eventPayloadBytes +
        b.sourceBodyBytes +
        (b.ftsIndexBytes ?? 0) +
        (b.vectorBytesEstimate ?? 0);
      const share = (n: number) => (measured > 0 ? ` (${Math.round((n / measured) * 100)}%)` : "");
      this.context.stdout.write("  body storage:\n");
      this.context.stdout.write(
        `    events (all versions)  ${formatBytes(b.eventPayloadBytes)}${share(b.eventPayloadBytes)}\n`,
      );
      this.context.stdout.write(
        `    sources (current)      ${formatBytes(b.sourceBodyBytes)}${share(b.sourceBodyBytes)}\n`,
      );
      this.context.stdout.write(
        `    fts index              ${
          b.ftsIndexBytes === null
            ? "(unmeasurable)"
            : formatBytes(b.ftsIndexBytes) + share(b.ftsIndexBytes)
        }\n`,
      );
      this.context.stdout.write(
        `    vectors (est.)         ${
          b.vectorBytesEstimate === null
            ? "(none)"
            : formatBytes(b.vectorBytesEstimate) + share(b.vectorBytesEstimate)
        }\n`,
      );
      if (info.bytesPerDay !== null) {
        this.context.stdout.write(
          `  growth:     ~${formatBytes(info.bytesPerDay)}/day (average)\n`,
        );
      }
      if (breakdown !== undefined) {
        this.context.stdout.write("  events by type:\n");
        if (breakdown.length === 0) {
          this.context.stdout.write("    (none)\n");
        } else {
          for (const e of breakdown) {
            this.context.stdout.write(`    ${e.type.padEnd(24)} ${e.count}\n`);
          }
        }
      }
      return 0;
    } finally {
      store.close();
    }
  }
}
