/**
 * Assistant-skill install / status / drift (ADR-0008).
 *
 * Verifies the service writes only the bundled assistant skills, is idempotent,
 * detects drift, and reports per-host status. A synthetic SSOT tree keeps the
 * tests independent of the real catalog contents.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectDrift,
  installSkills,
  listBundledSkills,
  mirrorPath,
  resolveSkillsSource,
  scopeHosts,
  skillStatuses,
} from "../../src/skills/index.ts";

let root: string;
let sourceDir: string;
let baseDir: string;

/** Bundled skills used across cases (name → body). */
const FIXTURE = {
  "personal-brief": "# personal-brief\nbody A\n",
  "next-actions": "# next-actions\nbody B\n",
} as const;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "suasor-skills-"));
  // Synthetic SSOT: <root>/docs/skills/<name>/SKILL.md
  sourceDir = join(root, "docs", "skills");
  for (const [name, body] of Object.entries(FIXTURE)) {
    mkdirSync(join(sourceDir, name), { recursive: true });
    writeFileSync(join(sourceDir, name, "SKILL.md"), body);
  }
  // A non-skill dir (no SKILL.md) must be ignored.
  mkdirSync(join(sourceDir, "not-a-skill"), { recursive: true });
  baseDir = join(root, "project");
  mkdirSync(baseDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function bundled() {
  return listBundledSkills(sourceDir);
}

describe("listBundledSkills", () => {
  test("enumerates only dirs that contain SKILL.md, sorted", () => {
    const skills = bundled();
    expect(skills.map((s) => s.name)).toEqual(["next-actions", "personal-brief"]);
    for (const s of skills) expect(existsSync(s.sourcePath)).toBe(true);
  });
});

describe("resolveSkillsSource", () => {
  test("walks up to find docs/skills", () => {
    const nested = join(root, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    expect(resolveSkillsSource(nested)).toBe(sourceDir);
  });

  test("returns null when no docs/skills exists above startDir", () => {
    const isolated = mkdtempSync(join(tmpdir(), "suasor-noskills-"));
    try {
      expect(resolveSkillsSource(isolated)).toBeNull();
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });
});

describe("installSkills", () => {
  test("writes every bundled skill into both host dirs (scope=all)", () => {
    const results = installSkills({ baseDir, skills: bundled() });
    expect(results.every((r) => r.action === "created")).toBe(true);
    for (const host of scopeHosts("all")) {
      for (const name of Object.keys(FIXTURE)) {
        const p = mirrorPath(baseDir, host, name);
        expect(existsSync(p)).toBe(true);
        expect(readFileSync(p, "utf8")).toBe(FIXTURE[name as keyof typeof FIXTURE]);
      }
    }
  });

  test("scope=claude writes only .claude/skills", () => {
    installSkills({ baseDir, scope: "claude", skills: bundled() });
    expect(existsSync(join(baseDir, ".claude", "skills", "personal-brief", "SKILL.md"))).toBe(true);
    expect(existsSync(join(baseDir, ".agents", "skills", "personal-brief", "SKILL.md"))).toBe(
      false,
    );
  });

  test("does not write ecosystem / non-skill dirs", () => {
    installSkills({ baseDir, skills: bundled() });
    expect(existsSync(join(baseDir, ".claude", "skills", "not-a-skill"))).toBe(false);
  });

  test("is idempotent: a second run reports unchanged and rewrites nothing", () => {
    installSkills({ baseDir, skills: bundled() });
    const second = installSkills({ baseDir, skills: bundled() });
    expect(second.every((r) => r.action === "unchanged")).toBe(true);
  });

  test("refreshes a drifted mirror (updated)", () => {
    installSkills({ baseDir, skills: bundled() });
    const target = mirrorPath(baseDir, "claude", "personal-brief");
    writeFileSync(target, "locally edited\n");
    const again = installSkills({ baseDir, scope: "claude", skills: bundled() });
    const hit = again.find((r) => r.name === "personal-brief");
    expect(hit?.action).toBe("updated");
    expect(readFileSync(target, "utf8")).toBe(FIXTURE["personal-brief"]);
  });

  test("dry-run reports actions but writes nothing", () => {
    const results = installSkills({ baseDir, dryRun: true, skills: bundled() });
    expect(results.every((r) => r.action === "created")).toBe(true);
    expect(existsSync(join(baseDir, ".claude", "skills"))).toBe(false);
    expect(existsSync(join(baseDir, ".agents", "skills"))).toBe(false);
  });
});

describe("skillStatuses / detectDrift", () => {
  test("missing before install, installed after", () => {
    const before = skillStatuses({ baseDir, scope: "claude", skills: bundled() });
    expect(before.every((s) => s.state === "missing")).toBe(true);

    installSkills({ baseDir, scope: "claude", skills: bundled() });
    const after = skillStatuses({ baseDir, scope: "claude", skills: bundled() });
    expect(after.every((s) => s.state === "installed")).toBe(true);
  });

  test("modified state when a mirror diverges from the SSOT", () => {
    installSkills({ baseDir, scope: "claude", skills: bundled() });
    writeFileSync(mirrorPath(baseDir, "claude", "next-actions"), "edited\n");
    const statuses = skillStatuses({ baseDir, scope: "claude", skills: bundled() });
    const hit = statuses.find((s) => s.name === "next-actions");
    expect(hit?.state).toBe("modified");
  });

  test("detectDrift returns missing + modified mirrors only", () => {
    installSkills({ baseDir, scope: "claude", skills: bundled() });
    writeFileSync(mirrorPath(baseDir, "claude", "next-actions"), "edited\n");
    const drift = detectDrift({ baseDir, scope: "claude", skills: bundled() });
    expect(drift.map((d) => d.name)).toEqual(["next-actions"]);
    expect(drift[0]?.state).toBe("modified");

    // After re-install, drift is empty.
    installSkills({ baseDir, scope: "claude", skills: bundled() });
    expect(detectDrift({ baseDir, scope: "claude", skills: bundled() })).toEqual([]);
  });
});

describe("real bundled catalog", () => {
  test("the shipped docs/skills resolves and is non-empty", () => {
    const src = resolveSkillsSource();
    expect(src).not.toBeNull();
    const skills = listBundledSkills(src);
    expect(skills.length).toBeGreaterThanOrEqual(18);
    expect(skills.map((s) => s.name)).toContain("personal-brief");
  });

  test("ships the ledger / identity HITL skills (commitment / proposal / person)", () => {
    const names = listBundledSkills(resolveSkillsSource()).map((s) => s.name);
    expect(names).toContain("commitment-review");
    expect(names).toContain("proposal-review");
    expect(names).toContain("person-cleanup");
  });

  test("every bundled skill has frontmatter whose name matches its directory", () => {
    for (const skill of listBundledSkills(resolveSkillsSource())) {
      const body = readFileSync(skill.sourcePath, "utf8");
      const block = body.match(/^---\n([\s\S]*?)\n---/)?.[1];
      expect(block).toBeDefined();
      const frontmatter = block ?? "";
      const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim();
      expect(name).toBe(skill.name);
      // description is the natural-language trigger surface; it must be present.
      expect(frontmatter).toMatch(/^description:\s*\S/m);
    }
  });
});
