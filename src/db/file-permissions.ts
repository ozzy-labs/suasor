/**
 * Owner-only permissions for the files that hold ingested content (ADR-0048).
 *
 * The store concentrates a person's whole work context — Slack DMs, mail
 * bodies, calendar entries, extracted document text — into one plaintext SQLite
 * file. Until Issue #529 that file was created with the process umask, which on
 * a typical box means `0644`: **every local user could read all of it**, while
 * ADR-0003 called it a "private store". Owner-only is not a mitigation for a
 * stolen disk (that is the OS's full-disk encryption, ADR-0048 §threat model) —
 * it is what makes the word "private" true on a shared machine.
 *
 * Applied at *every* creation point rather than in `init` alone: the database is
 * created by whichever command opens it first, and the WAL / SHM sidecars are
 * created by SQLite later, on first write.
 */
import { chmodSync } from "node:fs";

/** Owner read/write only (`-rw-------`). */
export const FILE_MODE = 0o600;

/** Owner traverse/read/write only (`drwx------`). */
export const DIR_MODE = 0o700;

/**
 * POSIX-only: Windows maps `chmod` to the read-only bit alone, so requesting
 * `0600` there neither restricts other users nor errors — it silently does
 * something else. Callers that *report* on permissions (doctor) must not claim
 * a guarantee the platform cannot make, so the platform check lives here and is
 * exported rather than repeated.
 */
export const PERMISSIONS_ENFORCEABLE = process.platform !== "win32";

/**
 * Best-effort `chmod` that never fails the caller. Synchronous so it can run on
 * the `openDatabase` path, which is sync by design.
 *
 * A store on a filesystem that does not carry Unix modes (a mounted share, a
 * FAT volume) must not stop Suasor from opening its database — the permission
 * tightening is a hardening step, not a precondition. Doctor reports the actual
 * on-disk mode, so a chmod that quietly did nothing is still visible there
 * rather than being assumed to have worked.
 */
export function restrictPath(path: string, mode: number): void {
  if (!PERMISSIONS_ENFORCEABLE) return;
  try {
    chmodSync(path, mode);
  } catch {
    // Ignored deliberately — see the doc comment.
  }
}

/**
 * Restrict a database file and the WAL / SHM sidecars SQLite creates beside it.
 *
 * The sidecars matter as much as the `.db`: `-wal` holds recently written pages
 * verbatim, so a world-readable WAL leaks exactly the content that was ingested
 * most recently. They may not exist yet (WAL appears on first write), and
 * `restrictPath` swallows that.
 */
export function restrictDatabaseFiles(dbPath: string): void {
  if (dbPath === ":memory:" || dbPath === "") return;
  restrictPath(dbPath, FILE_MODE);
  restrictPath(`${dbPath}-wal`, FILE_MODE);
  restrictPath(`${dbPath}-shm`, FILE_MODE);
}
