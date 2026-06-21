/**
 * Consistent local store backup (Issue #280).
 *
 * The event log is the single source of truth (ADR-0002); the projection /
 * vec0 / FTS substrates are derived (rebuildable by replay). A backup must
 * therefore capture the SQLite database in a *consistent* state — never a torn
 * copy taken mid-write while the WAL holds uncommitted frames.
 *
 * Two formats:
 *  - `sqlite` (default): a single self-contained `.db` file produced by SQLite's
 *    `VACUUM INTO`. It runs inside a read transaction and folds the WAL into the
 *    output, so the result is a clean, defragmented snapshot with no `-wal` /
 *    `-shm` sidecars — the simplest thing to copy off-box or `suasor init`
 *    against later. This is the canonical, integrity-checked format.
 *  - `tgz`: a gzip-compressed tar of the consistent snapshot (the same
 *    `VACUUM INTO` output), for size-efficient archival. We tar the vacuumed
 *    single file rather than the live `.db` + `-wal` + `-shm` triple so the
 *    archive is always internally consistent regardless of checkpoint state.
 *
 * Read-only with respect to the source store: `VACUUM INTO` takes a read lock
 * and writes only to the destination path; the live database is never mutated
 * (no side effects, per the Issue's invariant).
 *
 * Heavy work is kept here (not the CLI command) so it can be unit-tested
 * directly and reused by a future MCP/maintenance path.
 */
import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** Backup output formats. `sqlite` is the canonical single-file snapshot. */
export type BackupFormat = "sqlite" | "tgz";

/** Result of a completed backup. */
export interface BackupResult {
  /** Absolute path the backup was written to. */
  outPath: string;
  /** Format produced. */
  format: BackupFormat;
  /** Size in bytes of the written backup. */
  sizeBytes: number;
  /** Number of events captured (integrity cross-check against the source). */
  events: number;
}

/** Quote a path for safe single-quoted SQL embedding (`VACUUM INTO` takes no params). */
function sqlQuote(path: string): string {
  return `'${path.replace(/'/g, "''")}'`;
}

/**
 * Produce a consistent single-file snapshot of `sqlite` at `destPath` via
 * `VACUUM INTO`. The destination must not already exist (SQLite refuses to
 * overwrite). Runs in a read transaction, folding the WAL into the snapshot.
 */
function vacuumInto(sqlite: Database, destPath: string): void {
  sqlite.exec(`VACUUM INTO ${sqlQuote(destPath)};`);
}

/**
 * Count events in a (possibly just-written) SQLite file by opening it read-only.
 * Used as an integrity cross-check: the snapshot must carry the same event
 * count as the live store (ADR-0002 — the log is the truth being backed up).
 */
async function countEventsIn(path: string): Promise<number> {
  const { Database: Db } = await import("bun:sqlite");
  const db = new Db(path, { readonly: true });
  try {
    const row = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get();
    return row?.n ?? 0;
  } finally {
    db.close();
  }
}

/**
 * Write a consistent backup of the open store to `outPath`.
 *
 * @param sqlite   open source database handle (read-only access; not mutated).
 * @param outPath  destination file path. Must not already exist.
 * @param format   `sqlite` (single-file VACUUM snapshot) or `tgz` (gzip tar of it).
 * @throws when `outPath` already exists, when the source has no `events` table
 *   (not a Suasor store), or when the integrity cross-check fails.
 */
export async function backupStore(
  sqlite: Database,
  outPath: string,
  format: BackupFormat = "sqlite",
): Promise<BackupResult> {
  const dest = resolve(outPath);
  if (existsSync(dest)) {
    throw new Error(`refusing to overwrite existing file: ${dest}`);
  }
  // Fail fast on a non-Suasor DB so we never emit a "successful" empty backup.
  const srcEvents = sqlite.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get();
  const expected = srcEvents?.n ?? 0;

  if (format === "sqlite") {
    vacuumInto(sqlite, dest);
    const events = await countEventsIn(dest);
    if (events !== expected) {
      rmSync(dest, { force: true });
      throw new Error(
        `backup integrity check failed: ${events} events in snapshot, ${expected} expected`,
      );
    }
    return { outPath: dest, format, sizeBytes: statSync(dest).size, events };
  }

  // tgz: VACUUM into a temp single file, integrity-check it, then gzip-tar it so
  // the archive is internally consistent regardless of WAL checkpoint state.
  const stage = mkdtempSync(join(tmpdir(), "suasor-backup-"));
  const snapshotName = "suasor.db";
  const snapshotPath = join(stage, snapshotName);
  try {
    vacuumInto(sqlite, snapshotPath);
    const events = await countEventsIn(snapshotPath);
    if (events !== expected) {
      throw new Error(
        `backup integrity check failed: ${events} events in snapshot, ${expected} expected`,
      );
    }
    // `tar -czf <out> -C <stage> <snapshot>`: archive just the consistent file.
    const proc = Bun.spawnSync(["tar", "-czf", dest, "-C", stage, snapshotName], {
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) {
      rmSync(dest, { force: true });
      const stderr = proc.stderr?.toString().trim() ?? "";
      throw new Error(`tar failed (exit ${proc.exitCode})${stderr ? `: ${stderr}` : ""}`);
    }
    return { outPath: dest, format, sizeBytes: statSync(dest).size, events };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/**
 * Back up a store *file* without mutating it (no side effects, per the Issue's
 * invariant). Unlike `Store.open`, this opens the source database **read-only**
 * and does NOT run schema init / column migrations / vec-extension load — those
 * would write DDL (e.g. `ALTER TABLE ... ADD COLUMN`, `CREATE TABLE`) to a
 * legacy store before the snapshot, contradicting "the live database is never
 * mutated". `VACUUM INTO` works fine over a read-only handle. The CLI uses this
 * (rather than opening through the Store service) so a backup is strictly read.
 *
 * @param dbPath   path to the source SQLite database file.
 * @param outPath  destination file path. Must not already exist.
 * @param format   `sqlite` or `tgz`.
 */
export async function backupStoreFile(
  dbPath: string,
  outPath: string,
  format: BackupFormat = "sqlite",
): Promise<BackupResult> {
  const { Database: Db } = await import("bun:sqlite");
  const sqlite = new Db(dbPath, { readonly: true });
  try {
    return await backupStore(sqlite, outPath, format);
  } finally {
    sqlite.close();
  }
}

/**
 * Default backup file name for a given format, timestamped to the current time
 * (UTC, filesystem-safe). The CLI uses this when `--out` is omitted, writing
 * into the database's directory.
 */
export function defaultBackupName(format: BackupFormat, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");
  return format === "tgz" ? `suasor-backup-${stamp}.tgz` : `suasor-backup-${stamp}.db`;
}

/** Resolve the directory a default-named backup lands in (the DB's own dir). */
export function defaultBackupDir(dbPath: string): string {
  return dirname(resolve(dbPath));
}

/** The plain file name (no dir) of a path — used for human-readable output. */
export function backupBasename(path: string): string {
  return basename(path);
}
