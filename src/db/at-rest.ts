/**
 * At-rest posture of the store, for `suasor doctor` (ADR-0048).
 *
 * Two questions, deliberately reported apart because Suasor can answer them
 * with very different confidence:
 *
 *  1. **Permissions** — can another user on this machine read the store? Suasor
 *     sets owner-only and can read the mode straight back, so this is a fact.
 *  2. **Full-disk encryption** — is the store protected once the disk leaves the
 *     machine? Suasor cannot provide this (SQLCipher is not available under
 *     `bun:sqlite`, and encrypting bodies would forfeit FTS-first, ADR-0005), so
 *     ADR-0048 leans on the OS for it. A premise nobody checks is a premise that
 *     silently fails, so this checks it — **where the platform can answer**.
 *
 * On Linux the answer is `unknown`, not `off`. LUKS, LVM-on-LUKS, ZFS native
 * encryption, eCryptfs and a dozen vendor variants all count, and none has a
 * probe that is right often enough to be worth trusting. Reporting `unknown`
 * costs the operator one manual check; reporting a guessed `ok` would tell them
 * they are protected when they may not be (ADR-0007 "no silent wrong answer").
 */
import { statSync } from "node:fs";
import { PERMISSIONS_ENFORCEABLE } from "./file-permissions.ts";

/** Whether a path is readable by group/others, with the raw mode for reporting. */
export interface PathPermissions {
  path: string;
  /** Permission bits (`mode & 0o777`), or `null` when the path does not exist. */
  mode: number | null;
  /** `true` when any group/other bit is set — i.e. someone else can read it. */
  worldReadable: boolean;
}

/** `mode & 0o777` as the conventional octal string (e.g. `600`). */
export function formatMode(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, "0");
}

/**
 * Inspect a path's permission bits. A missing path reports `mode: null` and is
 * never treated as exposed — "not there" is not "readable".
 */
export function inspectPermissions(path: string): PathPermissions {
  try {
    const mode = statSync(path).mode & 0o777;
    return { path, mode, worldReadable: (mode & 0o077) !== 0 };
  } catch {
    return { path, mode: null, worldReadable: false };
  }
}

/**
 * The store's files: the database plus the WAL / SHM sidecars, which hold
 * recently written pages verbatim and are therefore just as sensitive.
 */
export function storePaths(dbPath: string): string[] {
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
}

/** Full-disk-encryption verdict for the host. */
export type DiskEncryptionState = "on" | "off" | "unknown";

export interface DiskEncryption {
  state: DiskEncryptionState;
  /** How it was determined (or why it could not be), for the doctor detail line. */
  detail: string;
}

/** Injectable command runner so the probes are testable without a real OS. */
export type RunCommand = (cmd: string[]) => Promise<{ ok: boolean; stdout: string }>;

const defaultRun: RunCommand = async (cmd) => {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    return { ok: code === 0, stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
};

/**
 * Best-effort full-disk-encryption probe.
 *
 * - **macOS**: `fdesetup status` prints "FileVault is On/Off." — an official,
 *   stable, unprivileged status command.
 * - **Windows**: `manage-bde -status` reports per-volume protection status.
 * - **Everything else**: `unknown`. See the module doc for why Linux is not
 *   guessed at.
 */
export async function detectDiskEncryption(
  platform: string = process.platform,
  run: RunCommand = defaultRun,
): Promise<DiskEncryption> {
  if (platform === "darwin") {
    const { ok, stdout } = await run(["fdesetup", "status"]);
    if (!ok) return { state: "unknown", detail: "could not run `fdesetup status`" };
    if (/FileVault is On/i.test(stdout)) return { state: "on", detail: "FileVault is on" };
    if (/FileVault is Off/i.test(stdout)) return { state: "off", detail: "FileVault is off" };
    return { state: "unknown", detail: "unrecognized `fdesetup status` output" };
  }
  if (platform === "win32") {
    const { ok, stdout } = await run(["manage-bde", "-status"]);
    if (!ok) return { state: "unknown", detail: "could not run `manage-bde -status`" };
    // "Protection On" appears per volume; any volume off is worth surfacing.
    if (/Protection\s+Off/i.test(stdout)) return { state: "off", detail: "BitLocker is off" };
    if (/Protection\s+On/i.test(stdout)) return { state: "on", detail: "BitLocker is on" };
    return { state: "unknown", detail: "unrecognized `manage-bde -status` output" };
  }
  return {
    state: "unknown",
    detail:
      `no reliable probe on ${platform} (LUKS / LVM / ZFS native / eCryptfs all count ` +
      "and none is detectable with confidence) — verify full-disk encryption yourself",
  };
}

/** Whether this platform can enforce, and therefore report on, Unix modes. */
export { PERMISSIONS_ENFORCEABLE };
