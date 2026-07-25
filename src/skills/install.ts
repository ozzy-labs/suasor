/**
 * Assistant-skill install / status / drift (ADR-0008).
 *
 * `installSkills` expands every bundled `docs/skills/<name>/SKILL.md` (the SSOT)
 * into the selected host dirs (`.claude/skills/` / `.agents/skills/`). Only the
 * bundled assistant skills are written — ecosystem dev skills (`@ozzylabs/skills`)
 * live in a disjoint namespace and are never touched here.
 *
 * `skillStatuses` reports per-skill, per-host status (`installed` / `missing` /
 * `modified`) for `suasor skills list`. `detectDrift` reduces that to the set of
 * out-of-sync mirrors so the in-repo dogfood copies can be kept identical to the
 * SSOT (lefthook drift check).
 *
 * No heavy dependencies: only `node:fs` / `node:path` (NFR-PRF-1).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type BundledSkill,
  HOSTS,
  type Host,
  listBundledSkills,
  readSkillSource,
  type Scope,
  SKILL_FILE,
  scopeHosts,
} from "./catalog.ts";

export {
  type BundledSkill,
  HOSTS,
  type Host,
  listBundledSkills,
  listEmbeddedSkills,
  readSkillSource,
  resolveSkillsSource,
  SCOPES,
  type Scope,
  SKILL_FILE,
  scopeHosts,
} from "./catalog.ts";

/** One skill's installed state relative to the SSOT, per host. */
export type SkillState = "installed" | "missing" | "modified";

export interface SkillStatus {
  readonly name: string;
  readonly host: Host;
  /** Absolute path of the mirror this status describes. */
  readonly mirrorPath: string;
  readonly state: SkillState;
}

export interface InstallOptions {
  /** Base dir the host dirs are resolved under (default: cwd). */
  readonly baseDir?: string;
  /**
   * suasor version to stamp the written host dirs with (Issue #445). Omitted →
   * no stamp is written (the pure-catalog tests do not care about staleness).
   */
  readonly version?: string;
  /** Which host dir(s) to write (default: `all`). */
  readonly scope?: Scope;
  /** Only the named hosts (overrides `scope` when set). */
  readonly hosts?: readonly Host[];
  /** When true, compute changes but write nothing. */
  readonly dryRun?: boolean;
  /** Injectable skill catalog (defaults to the bundled set). */
  readonly skills?: readonly BundledSkill[];
}

/** What an install did (or, with `dryRun`, would do) to one mirror. */
export type InstallAction = "created" | "updated" | "unchanged";

export interface InstallResult {
  readonly name: string;
  readonly host: Host;
  readonly mirrorPath: string;
  readonly action: InstallAction;
}

/** Resolve the absolute mirror path for a skill under a host dir. */
export function mirrorPath(baseDir: string, host: Host, name: string): string {
  return join(baseDir, HOSTS[host], name, SKILL_FILE);
}

/** Read a file's text, or `null` when it does not exist / is unreadable. */
function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Expand bundled assistant skills into the selected host dirs.
 *
 * Idempotent: an unchanged mirror is left as-is (`unchanged`); a missing one is
 * `created`; a drifted one is `updated`. With `dryRun`, nothing is written but
 * the actions reflect what would happen.
 */
export function installSkills(options: InstallOptions = {}): InstallResult[] {
  const baseDir = options.baseDir ?? process.cwd();
  const scope: Scope = options.scope ?? "all";
  const hosts = options.hosts ?? scopeHosts(scope);
  const skills = options.skills ?? listBundledSkills();
  const dryRun = options.dryRun ?? false;

  const results: InstallResult[] = [];
  for (const skill of skills) {
    const source = readSkillSource(skill);
    for (const host of hosts) {
      const target = mirrorPath(baseDir, host, skill.name);
      const current = readTextOrNull(target);
      const action: InstallAction =
        current === null ? "created" : current === source ? "unchanged" : "updated";
      if (!dryRun && action !== "unchanged") {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, source);
      }
      results.push({ name: skill.name, host, mirrorPath: target, action });
    }
  }
  // Stamp each host dir with the writing version so a later run can tell an
  // agent it is reading mirrors from a different suasor (Issue #445). Written
  // beside the mirrors, never inside them — a mirror must stay byte-identical
  // to its SSOT or drift detection would flag every skill.
  if (!dryRun && options.version !== undefined && skills.length > 0) {
    for (const host of hosts) {
      const path = stampPath(baseDir, host);
      mkdirSync(dirname(path), { recursive: true });
      const stamp: SkillsStamp = {
        version: options.version,
        installedAt: new Date().toISOString(),
      };
      writeFileSync(path, `${JSON.stringify(stamp, null, 2)}\n`);
    }
  }
  return results;
}

/**
 * Report per-skill, per-host status against the SSOT for `skills list`.
 *
 * `missing` = no mirror; `installed` = mirror matches SSOT; `modified` = mirror
 * exists but differs from SSOT (local edit / SSOT moved on).
 */
export function skillStatuses(options: InstallOptions = {}): SkillStatus[] {
  const baseDir = options.baseDir ?? process.cwd();
  const scope: Scope = options.scope ?? "all";
  const hosts = options.hosts ?? scopeHosts(scope);
  const skills = options.skills ?? listBundledSkills();

  const statuses: SkillStatus[] = [];
  for (const skill of skills) {
    const source = readSkillSource(skill);
    for (const host of hosts) {
      const target = mirrorPath(baseDir, host, skill.name);
      const current = readTextOrNull(target);
      const state: SkillState =
        current === null ? "missing" : current === source ? "installed" : "modified";
      statuses.push({ name: skill.name, host, mirrorPath: target, state });
    }
  }
  return statuses;
}

/**
 * Drift = any mirror that is `missing` or `modified` relative to the SSOT.
 *
 * Used by the in-repo dogfood lefthook hook to keep `.claude/skills/` and
 * `.agents/skills/` byte-identical to `docs/skills/`.
 */
export function detectDrift(options: InstallOptions = {}): SkillStatus[] {
  return skillStatuses(options).filter((s) => s.state !== "installed");
}

/** Sidecar file recording which suasor version wrote a host dir's mirrors. */
export const STAMP_FILE = ".suasor-skills.json";

/** Contents of the {@link STAMP_FILE} stamp. */
export interface SkillsStamp {
  /** `package.json` version of the suasor that wrote these mirrors. */
  readonly version: string;
  /** ISO 8601 write time (informational; drift is judged on `version`). */
  readonly installedAt: string;
}

/** Absolute path of a host dir's stamp file. */
export function stampPath(baseDir: string, host: Host): string {
  return join(baseDir, HOSTS[host], STAMP_FILE);
}

/**
 * Read a host dir's install stamp, or `null` when absent / unreadable / malformed.
 *
 * A missing stamp is not an error: it means the mirrors predate stamping (or
 * were written by hand), which the staleness check reports as "unknown" rather
 * than pretending they are current.
 */
export function readStamp(baseDir: string, host: Host): SkillsStamp | null {
  const raw = readTextOrNull(stampPath(baseDir, host));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SkillsStamp>;
    if (typeof parsed.version !== "string" || parsed.version.length === 0) return null;
    return { version: parsed.version, installedAt: parsed.installedAt ?? "" };
  } catch {
    return null;
  }
}

/**
 * One-line warning when an installed mirror was written by a different suasor
 * version than the one running (Issue #445), or `null` when everything the
 * caller can see is current.
 *
 * The check is **presence-gated**: a host dir with no mirrors at all is not
 * "stale", it is simply not installed — warning there would nag every user who
 * never ran `skills install`. Only a host dir that *has* mirrors and either
 * carries an older stamp or none at all is reported, since that is exactly the
 * case where the agent is reading skills that no longer match this binary.
 */
export function staleMirrorWarning(
  baseDir: string,
  currentVersion: string,
  hosts: readonly Host[] = ["claude", "agents"],
): string | null {
  const stale: string[] = [];
  for (const host of hosts) {
    const installed = skillStatuses({ baseDir, hosts: [host] }).some((s) => s.state !== "missing");
    if (!installed) continue;
    const stamp = readStamp(baseDir, host);
    if (stamp === null) stale.push(`${HOSTS[host]} (unstamped)`);
    else if (stamp.version !== currentVersion) stale.push(`${HOSTS[host]} (v${stamp.version})`);
  }
  if (stale.length === 0) return null;
  return (
    `warning: installed skill mirrors are from another suasor version — ${stale.join(", ")} ` +
    `vs running v${currentVersion}; refresh with \`suasor skills install\`\n`
  );
}
