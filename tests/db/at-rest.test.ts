/**
 * At-rest posture of the store (ADR-0048, Issue #529).
 *
 * The defect these pin: the store concentrates a person's whole work context
 * into one plaintext SQLite file, and it was created with the process umask —
 * `0644` on a typical box, i.e. readable by every local user, while ADR-0003
 * called it a "private store".
 *
 * The second thing pinned is the *reporting* discipline. Suasor can state
 * permissions as fact (it reads them back off disk) but cannot state full-disk
 * encryption on every platform, so the FDE probe must answer `unknown` rather
 * than guess — an `ok` nobody verified is worse than an admitted gap.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectDiskEncryption,
  formatMode,
  inspectPermissions,
  type RunCommand,
  storePaths,
} from "../../src/db/at-rest.ts";
import { Store } from "../../src/db/index.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "suasor-atrest-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const modeOf = (path: string) => statSync(path).mode & 0o777;

describe("store files are owner-only", () => {
  test("a freshly created database is not readable by other users", () => {
    const dbPath = join(dir, "s.db");
    const store = Store.open({ path: dbPath });
    store.close();
    expect(modeOf(dbPath)).toBe(0o600);
  });

  test("the WAL sidecar is restricted too — it holds the newest content verbatim", () => {
    const dbPath = join(dir, "s.db");
    const store = Store.open({ path: dbPath });
    store.record({
      type: "SourceObserved",
      externalId: "s1",
      sourceType: "slack_message",
      body: "a secret in the write-ahead log",
      observedAt: "2026-07-26T00:00:00.000Z",
      fingerprint: "s1",
      meta: {},
    });
    store.close();
    // Restricting only the .db would leave the most recently written pages —
    // the freshest ingested bodies — readable.
    expect(modeOf(`${dbPath}-wal`)).toBe(0o600);
  });

  test("reopening an already-exposed store tightens it in place", () => {
    const dbPath = join(dir, "s.db");
    Store.open({ path: dbPath }).close();
    chmodSync(dbPath, 0o644);
    // The upgrade path: a store created before this existed is fixed by the
    // next command that opens it, with no migration step to run.
    Store.open({ path: dbPath }).close();
    expect(modeOf(dbPath)).toBe(0o600);
  });

  test("a backup carries the same mode as the live store", async () => {
    const dbPath = join(dir, "s.db");
    const store = Store.open({ path: dbPath });
    const { backupStore } = await import("../../src/db/backup.ts");
    const out = join(dir, "backup.db");
    await backupStore(store.connection.sqlite, out, "sqlite");
    store.close();
    // A backup is a full copy of every ingested body, and is likelier than the
    // store to be written somewhere shared.
    expect(modeOf(out)).toBe(0o600);
  });

  test("a tgz archive is restricted too — tar writes it, not SQLite", async () => {
    const dbPath = join(dir, "s.db");
    const store = Store.open({ path: dbPath });
    const { backupStore } = await import("../../src/db/backup.ts");
    const out = join(dir, "backup.tgz");
    await backupStore(store.connection.sqlite, out, "tgz");
    store.close();
    // The staged snapshot is tightened and then discarded; the archive is a
    // separate file produced by `tar`, and carries the same content.
    expect(modeOf(out)).toBe(0o600);
  });
});

describe("inspectPermissions", () => {
  test("flags any group/other bit", () => {
    const p = join(dir, "f");
    Bun.write(p, "x");
    chmodSync(p, 0o640);
    expect(inspectPermissions(p).worldReadable).toBe(true);
    chmodSync(p, 0o600);
    expect(inspectPermissions(p).worldReadable).toBe(false);
  });

  test("a missing path is not 'exposed' — absent is not readable", () => {
    const p = inspectPermissions(join(dir, "nope"));
    expect(p.mode).toBeNull();
    expect(p.worldReadable).toBe(false);
  });

  test("storePaths covers the db and both sidecars", () => {
    expect(storePaths("/x/s.db")).toEqual(["/x/s.db", "/x/s.db-wal", "/x/s.db-shm"]);
  });

  test("formatMode renders the conventional octal", () => {
    expect(formatMode(0o600)).toBe("600");
    expect(formatMode(0o40755)).toBe("755");
  });
});

describe("detectDiskEncryption", () => {
  const run =
    (stdout: string, ok = true): RunCommand =>
    () =>
      Promise.resolve({ ok, stdout });

  test("reads FileVault status on macOS", async () => {
    expect((await detectDiskEncryption("darwin", run("FileVault is On."))).state).toBe("on");
    expect((await detectDiskEncryption("darwin", run("FileVault is Off."))).state).toBe("off");
  });

  test("reads BitLocker status on Windows", async () => {
    expect(
      (await detectDiskEncryption("win32", run("Protection Status: Protection On"))).state,
    ).toBe("on");
    expect(
      (await detectDiskEncryption("win32", run("Protection Status: Protection Off"))).state,
    ).toBe("off");
  });

  test("a failed probe is unknown, never 'off'", async () => {
    // "The command did not run" is not evidence of an unencrypted disk, and
    // reporting it as one would train the operator to ignore the check.
    expect((await detectDiskEncryption("darwin", run("", false))).state).toBe("unknown");
  });

  test("unrecognized output is unknown, never 'on'", async () => {
    expect((await detectDiskEncryption("darwin", run("something else"))).state).toBe("unknown");
  });

  test("linux answers unknown and says to check by hand", async () => {
    const r = await detectDiskEncryption("linux", run(""));
    // LUKS / LVM-on-LUKS / ZFS native / eCryptfs all count and none probes
    // reliably; a guessed "ok" would tell someone they are protected when the
    // check never established it (ADR-0007).
    expect(r.state).toBe("unknown");
    expect(r.detail).toContain("LUKS");
  });
});
