/**
 * Assistant-skill catalog (ADR-0008).
 *
 * The SSOT for every bundled assistant skill is `docs/skills/<name>/SKILL.md`,
 * shipped in the package `files` list. This module locates that source tree —
 * whether running from the repo (dev / dogfood) or from an installed npm
 * package (where `docs/skills` sits next to `dist/`) — and enumerates the
 * bundled skills found there.
 *
 * No heavy dependencies: only `node:fs` / `node:path`, so the CLI can lazy-load
 * it cheaply (NFR-PRF-1).
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The single SKILL file name authored per skill directory. */
export const SKILL_FILE = "SKILL.md";

/** Agent hosts that assistant skills install into (ADR-0008). */
export const HOSTS = {
  /** Claude Code reads `.claude/skills/`. */
  claude: ".claude/skills",
  /** Codex / Copilot / Gemini read `.agents/skills/`. */
  agents: ".agents/skills",
} as const;

export type Host = keyof typeof HOSTS;

/** Install scopes selecting which host dir(s) to write (`--scope`). */
export const SCOPES = ["claude", "agents", "all"] as const;
export type Scope = (typeof SCOPES)[number];

/** Resolve a scope to the concrete host list it covers. */
export function scopeHosts(scope: Scope): Host[] {
  return scope === "all" ? ["claude", "agents"] : [scope];
}

/** A bundled skill: its `name` and the absolute path to its SSOT `SKILL.md`. */
export interface BundledSkill {
  readonly name: string;
  readonly sourcePath: string;
}

/**
 * Locate the bundled `docs/skills` directory by walking up from this module.
 *
 * Works both in-repo (`src/skills/` → repo root holds `docs/skills`) and when
 * installed (`dist/` → package root holds `docs/skills`, per package.json
 * `files`). Returns `null` when no candidate exists.
 */
export function resolveSkillsSource(startDir: string = dirname(fileURLToPath(import.meta.url))): string | null {
  let dir = startDir;
  // Walk up to the filesystem root looking for a `docs/skills` directory.
  for (;;) {
    const candidate = join(dir, "docs", "skills");
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Enumerate bundled skills under `sourceDir` (defaults to the resolved source).
 *
 * A directory counts as a skill iff it contains a `SKILL.md`. Results are
 * sorted by name for deterministic output. Throws when no source can be found.
 */
export function listBundledSkills(sourceDir: string | null = resolveSkillsSource()): BundledSkill[] {
  if (sourceDir === null) {
    throw new Error(
      "could not locate bundled skills (docs/skills/); reinstall the package or run from the repo",
    );
  }
  const skills: BundledSkill[] = [];
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sourcePath = join(sourceDir, entry.name, SKILL_FILE);
    if (existsSync(sourcePath)) skills.push({ name: entry.name, sourcePath });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}
