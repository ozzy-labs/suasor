/**
 * `suasor export backup [--out <path>] [--format sqlite|tgz]` — write a
 * consistent backup of the local store (Issue #280).
 *
 * local-first / event-sourced: the event log is the single source of truth
 * (ADR-0002), but the base install has no built-in way to copy it off-box. This
 * verb produces a *consistent* snapshot — never a torn mid-write copy — so an
 * operator can archive their private memory and restore it later (`suasor init`
 * against, or replace, the snapshot; restore prose lives in
 * docs/guide/data-audit.md).
 *
 * No side effects (read-only w.r.t. the store): the snapshot is produced by
 * SQLite `VACUUM INTO` under a read lock; the live database is never mutated.
 * Secrets are never touched — tokens live in the OS keychain, not the DB
 * (NFR-PRV-4), so a store backup carries no credentials.
 *
 * Lazy-import discipline (NFR-PRF-1): the config loader, DB layer, and backup
 * service are imported inside `execute`; only clipanion is eager.
 */
import { existsSync } from "node:fs";
import { Command, Option } from "clipanion";
import { docsUrl } from "../doc-ref.ts";

export class ExportBackupCommand extends Command {
  static override paths = [["export", "backup"]];

  static override usage = Command.Usage({
    category: "Maintenance",
    description: "Write a consistent backup of the local store (event log + projections).",
    details: `
      Produces a consistent snapshot of the local store (ADR-0002 — the event log
      is the source of truth; projections/FTS/vec0 are rebuildable from it). The
      snapshot is taken with SQLite VACUUM INTO under a read lock, so it folds the
      WAL in and is never a torn mid-write copy. Read-only: the live database is
      not mutated, and no secrets are involved (tokens live in the OS keychain,
      not the DB — NFR-PRV-4).

      Formats:
        --format sqlite   single self-contained .db file (default; canonical)
        --format tgz      gzip tar of the consistent snapshot (archival)

      Without --out the backup lands next to the database with a timestamped
      name. Restore prose: ${docsUrl("guide/data-audit.md")}.
    `,
    examples: [
      ["Back up to a default-named file", "suasor export backup"],
      ["Back up to a chosen path", "suasor export backup --out /backups/suasor.db"],
      ["Compressed archive", "suasor export backup --format tgz"],
    ],
  });

  out = Option.String("--out", {
    description: "Destination path (default: timestamped file beside the database).",
  });

  format = Option.String("--format", "sqlite", {
    description: "Backup format: sqlite (default, single .db) or tgz (gzip tar).",
  });

  override async execute(): Promise<number> {
    const [{ loadConfig }, { formatBytes }, backup, { join }] = await Promise.all([
      import("../../config/index.ts"),
      import("../../db/index.ts"),
      import("../../db/backup.ts"),
      import("node:path"),
    ]);

    if (this.format !== "sqlite" && this.format !== "tgz") {
      this.context.stderr.write(
        `error: --format must be 'sqlite' or 'tgz' (got '${this.format}')\n`,
      );
      return 1;
    }
    const format = this.format;

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

    const outPath =
      this.out ?? join(backup.defaultBackupDir(dbPath), backup.defaultBackupName(format));
    if (existsSync(outPath)) {
      this.context.stderr.write(`error: refusing to overwrite existing file: ${outPath}\n`);
      return 1;
    }

    // Open the source read-only (no schema init / migrations) so the backup is
    // strictly read with no side effects on the live store (Issue invariant).
    try {
      const result = await backup.backupStoreFile(dbPath, outPath, format);
      this.context.stdout.write(
        `backup written: ${result.outPath}\n` +
          `  format: ${result.format}\n` +
          `  size:   ${formatBytes(result.sizeBytes)}\n` +
          `  events: ${result.events}\n`,
      );
      return 0;
    } catch (err) {
      this.context.stderr.write(
        `error: backup failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 1;
    }
  }
}
