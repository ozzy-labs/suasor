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
  type Host,
  HOSTS,
  listBundledSkills,
  type Scope,
  SKILL_FILE,
  scopeHosts,
} from "./catalog.ts";

export {
  type BundledSkill,
  type Host,
  HOSTS,
  listBundledSkills,
  resolveSkillsSource,
  type Scope,
  SCOPES,
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
    const source = readFileSync(skill.sourcePath, "utf8");
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
    const source = readFileSync(skill.sourcePath, "utf8");
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
