/**
 * Assistant-skill install / status / drift (ADR-0008).
 *
 * `installSkills` expands every bundled `docs/skills/<name>/SKILL.md` (the SSOT)
 * into the selected host dirs (`.claude/skills/` / `.agents/skills/`). Only the
 * bundled assistant skills are written — ecosystem dev skills (`@ozzylabs/skills`)
 * live in a disjoint namespace and are never touched here.
 *
 * `skillStatuses` reports per-skill, per-host status (`installed` / `missing` /
 * `modified` / `orphan`) for `suasor skills list`. `detectDrift` reduces that
 * to the out-of-sync subset, which is what makes `modified` reportable at all.
 * `orphanStatuses` / `pruneSkills` (#556) detect and delete mirrors whose names
 * have left the catalog (ADR-0046 folded 32 skills into 22, and install never
 * removed the retired mirrors), without ever touching foreign skill dirs.
 *
 * No heavy dependencies: only `node:fs` / `node:path` (NFR-PRF-1).
 */
import { type Dirent, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
export type SkillState = "installed" | "missing" | "modified" | "orphan";

/**
 * Skill names that were once bundled but have been removed or folded away
 * (ADR-0046 agent-surface contraction, 0.3.0). An upgraded install still
 * carries their mirrors — `installSkills` overwrites but never deletes — so
 * orphan detection must recognise them even when no stamp recorded them
 * (pre-#556 stamps carried no name list).
 *
 * This list only ever grows: a name added here stays even if a future skill
 * reuses it (catalog membership wins over this list, so a re-adopted name is
 * simply never reported as orphan).
 */
export const RETIRED_SKILLS: readonly string[] = [
  // → brief (ADR-0046 decision 3)
  "personal-brief",
  "catchup",
  "weekly-review",
  "external-brief",
  "health-check",
  // → source-review
  "doc-review",
  "pr-review",
  "doc-diff",
  // → find
  "find-document",
  "research",
  // → meeting
  "meeting-prep",
  "action-item-status",
  // → decisions
  "decision-log",
  "decision-rationale",
  // → draft
  "announcement-draft",
  "handoff-draft",
];

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
    const names = skills.map((s) => s.name);
    for (const host of hosts) {
      const path = stampPath(baseDir, host);
      mkdirSync(dirname(path), { recursive: true });
      // The stamp also records which skill names suasor wrote (#556), so a
      // future run can tell "suasor installed this, then the catalog dropped
      // it" (orphan) apart from a foreign skill it must never touch. Names a
      // previous stamp tracked are carried forward while their mirror still
      // exists on disk — otherwise re-installing would forget the very
      // orphans the record exists to identify.
      const carried = (readStamp(baseDir, host)?.skills ?? []).filter(
        (name) => !names.includes(name) && readTextOrNull(mirrorPath(baseDir, host, name)) !== null,
      );
      const stamp: SkillsStamp = {
        version: options.version,
        installedAt: new Date().toISOString(),
        skills: [...names, ...carried].sort((a, b) => a.localeCompare(b)),
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
 * exists but differs from SSOT (local edit / SSOT moved on); `orphan` = a
 * mirror suasor once wrote whose name has since left the catalog (#556) —
 * appended after the catalog rows so the cleanup signal actually exists.
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
  return [...statuses, ...orphanStatuses(options)];
}

/**
 * Mirrors present in a host dir for skills the catalog no longer bundles
 * (#556): the pre-ADR-0046 skill set survives every upgrade because
 * `installSkills` only ever iterates the current catalog.
 *
 * Ownership guard — ecosystem dev skills (`@ozzylabs/skills`: drive / commit /
 * review …) share the same host dirs, so "not in the catalog" alone is not
 * evidence suasor wrote it. A directory only counts as an orphan when suasor
 * demonstrably owned the name: it appears in the host dir's stamp name record
 * ({@link SkillsStamp.skills}) or in the historical {@link RETIRED_SKILLS}
 * list (which covers pre-#556 installs whose stamps carried no names).
 * Anything else is left alone, unreported.
 */
export function orphanStatuses(options: InstallOptions = {}): SkillStatus[] {
  const baseDir = options.baseDir ?? process.cwd();
  const scope: Scope = options.scope ?? "all";
  const hosts = options.hosts ?? scopeHosts(scope);
  const skills = options.skills ?? listBundledSkills();
  const catalog = new Set(skills.map((s) => s.name));

  const orphans: SkillStatus[] = [];
  for (const host of hosts) {
    const owned = new Set([...(readStamp(baseDir, host)?.skills ?? []), ...RETIRED_SKILLS]);
    let entries: Dirent[];
    try {
      entries = readdirSync(join(baseDir, HOSTS[host]), { withFileTypes: true });
    } catch {
      continue; // host dir absent → nothing installed, nothing orphaned
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || catalog.has(entry.name) || !owned.has(entry.name)) continue;
      const target = mirrorPath(baseDir, host, entry.name);
      if (readTextOrNull(target) === null) continue; // no SKILL.md → not a mirror
      orphans.push({ name: entry.name, host, mirrorPath: target, state: "orphan" });
    }
  }
  return orphans.sort((a, b) => a.name.localeCompare(b.name) || a.host.localeCompare(b.host));
}

/** What `pruneSkills` did (or, with `dryRun`, would do) to one orphaned mirror. */
export interface PruneResult {
  readonly name: string;
  readonly host: Host;
  /** Absolute path of the removed mirror's `SKILL.md`. */
  readonly mirrorPath: string;
  /** False under `dryRun` (the orphan was only reported). */
  readonly removed: boolean;
}

/**
 * Delete orphaned mirrors ({@link orphanStatuses}) from the host dirs (#556).
 *
 * Removes each orphan's whole `<host>/<name>/` directory, since the mirror dir
 * is install output owned by suasor. Restricted to the same ownership guard as
 * detection — foreign skill dirs are never candidates. With `dryRun`, reports
 * the candidates without deleting anything.
 */
export function pruneSkills(options: InstallOptions = {}): PruneResult[] {
  const baseDir = options.baseDir ?? process.cwd();
  const dryRun = options.dryRun ?? false;
  const results = orphanStatuses(options).map((orphan) => {
    if (!dryRun) rmSync(dirname(orphan.mirrorPath), { recursive: true, force: true });
    return {
      name: orphan.name,
      host: orphan.host,
      mirrorPath: orphan.mirrorPath,
      removed: !dryRun,
    };
  });
  // Drop the pruned names from each host stamp's ownership roster. A stale
  // roster would keep claiming names suasor no longer has anything on disk
  // for — and if the user later hand-placed their own skill under such a
  // name, the next prune would delete content suasor never wrote.
  if (!dryRun) {
    for (const host of new Set(results.map((r) => r.host))) {
      const stamp = readStamp(baseDir, host);
      if (stamp?.skills === undefined) continue;
      const prunedHere = new Set(results.filter((r) => r.host === host).map((r) => r.name));
      const skills = stamp.skills.filter((name) => !prunedHere.has(name));
      writeFileSync(stampPath(baseDir, host), `${JSON.stringify({ ...stamp, skills }, null, 2)}\n`);
    }
  }
  return results;
}

/**
 * Drift = any mirror that is `missing`, `modified` or `orphan` relative to the
 * SSOT catalog.
 *
 * A **derivation, not an enforcement point**: nothing runs this on commit. The
 * git hook it once described was removed with the in-repo mirror commits
 * (ADR-0035), and the mirrors are now local install output that is never
 * committed — so there is nothing for a hook to guard. It exists so
 * `suasor skills list` can report `modified`, and to let a caller ask "is this
 * host dir stale?" without diffing by hand.
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
  /**
   * Names of every skill mirror suasor has written into this host dir and not
   * yet pruned (#556) — the ownership record orphan detection diffs against
   * the catalog. Absent on stamps written before this field existed (those
   * installs fall back to {@link RETIRED_SKILLS}).
   */
  readonly skills?: readonly string[];
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
    const skills = Array.isArray(parsed.skills)
      ? parsed.skills.filter((name): name is string => typeof name === "string")
      : undefined;
    return {
      version: parsed.version,
      installedAt: parsed.installedAt ?? "",
      ...(skills === undefined ? {} : { skills }),
    };
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
