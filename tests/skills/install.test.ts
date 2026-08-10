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
  orphanStatuses,
  pruneSkills,
  readStamp,
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

  test("refreshes a drifted mirror suasor owns via the stamp record (updated)", () => {
    installSkills({ baseDir, skills: bundled(), version: "1.0.0" });
    const target = mirrorPath(baseDir, "claude", "next-actions");
    writeFileSync(target, "locally edited\n");
    const again = installSkills({ baseDir, scope: "claude", skills: bundled() });
    const hit = again.find((r) => r.name === "next-actions");
    expect(hit?.action).toBe("updated");
    expect(readFileSync(target, "utf8")).toBe(FIXTURE["next-actions"]);
  });

  test("refreshes a drifted retired-name mirror even without a stamp (pre-#556 install)", () => {
    // 'personal-brief' is a RETIRED_SKILLS member: historical ownership
    // evidence covers installs whose stamps carried no name record.
    installSkills({ baseDir, skills: bundled() }); // no version → no stamp
    const target = mirrorPath(baseDir, "claude", "personal-brief");
    writeFileSync(target, "locally edited\n");
    const again = installSkills({ baseDir, scope: "claude", skills: bundled() });
    expect(again.find((r) => r.name === "personal-brief")?.action).toBe("updated");
    expect(readFileSync(target, "utf8")).toBe(FIXTURE["personal-brief"]);
  });

  test("dry-run reports actions but writes nothing", () => {
    const results = installSkills({ baseDir, dryRun: true, skills: bundled() });
    expect(results.every((r) => r.action === "created")).toBe(true);
    expect(existsSync(join(baseDir, ".claude", "skills"))).toBe(false);
    expect(existsSync(join(baseDir, ".agents", "skills"))).toBe(false);
  });
});

describe("installSkills — user-authored collision guard (#563)", () => {
  /** Write a user-authored SKILL.md at a catalog path, bypassing installSkills. */
  function plantUserSkill(name: string, body = "# my own skill\n"): string {
    const target = mirrorPath(baseDir, "claude", name);
    mkdirSync(join(baseDir, ".claude", "skills", name), { recursive: true });
    writeFileSync(target, body);
    return target;
  }

  test("skips a differing file suasor cannot prove it wrote, and keeps it out of the stamp", () => {
    // 'next-actions' is not a retired name and no stamp records it → the
    // pre-existing file is user-authored evidence-wise and must survive.
    const target = plantUserSkill("next-actions");
    const results = installSkills({
      baseDir,
      scope: "claude",
      skills: bundled(),
      version: "1.0.0",
    });
    expect(results.find((r) => r.name === "next-actions")?.action).toBe("skipped");
    expect(readFileSync(target, "utf8")).toBe("# my own skill\n");
    // The stamp record must not claim the skipped name — otherwise the next
    // install (or prune) would treat the user's skill as suasor's.
    expect(readStamp(baseDir, "claude")?.skills).toEqual(["personal-brief"]);
    // ...so a re-run still skips instead of destroying it.
    const again = installSkills({ baseDir, scope: "claude", skills: bundled(), version: "1.0.0" });
    expect(again.find((r) => r.name === "next-actions")?.action).toBe("skipped");
    expect(readFileSync(target, "utf8")).toBe("# my own skill\n");
    // And it is never an orphan / prune candidate either.
    expect(orphanStatuses({ baseDir, scope: "claude", skills: bundled() })).toEqual([]);
  });

  test("force overwrites the user file and adopts the name into the stamp record", () => {
    const target = plantUserSkill("next-actions");
    const results = installSkills({
      baseDir,
      scope: "claude",
      skills: bundled(),
      version: "1.0.0",
      force: true,
    });
    expect(results.find((r) => r.name === "next-actions")?.action).toBe("updated");
    expect(readFileSync(target, "utf8")).toBe(FIXTURE["next-actions"]);
    expect(readStamp(baseDir, "claude")?.skills).toEqual(["next-actions", "personal-brief"]);
  });

  test("dry-run reports the skip without writing anything", () => {
    const target = plantUserSkill("next-actions");
    const results = installSkills({ baseDir, scope: "claude", skills: bundled(), dryRun: true });
    expect(results.find((r) => r.name === "next-actions")?.action).toBe("skipped");
    expect(readFileSync(target, "utf8")).toBe("# my own skill\n");
  });

  test("an identical file is unchanged, not skipped (no ownership question)", () => {
    plantUserSkill("next-actions", FIXTURE["next-actions"]);
    const results = installSkills({
      baseDir,
      scope: "claude",
      skills: bundled(),
      version: "1.0.0",
    });
    expect(results.find((r) => r.name === "next-actions")?.action).toBe("unchanged");
    // Byte-identical to the SSOT → effectively a mirror; recording it is safe.
    expect(readStamp(baseDir, "claude")?.skills).toEqual(["next-actions", "personal-brief"]);
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
    // version → the stamp records ownership, so the re-install below may
    // legitimately refresh the locally edited mirror (#563 guard satisfied).
    installSkills({ baseDir, scope: "claude", skills: bundled(), version: "1.0.0" });
    writeFileSync(mirrorPath(baseDir, "claude", "next-actions"), "edited\n");
    const drift = detectDrift({ baseDir, scope: "claude", skills: bundled() });
    expect(drift.map((d) => d.name)).toEqual(["next-actions"]);
    expect(drift[0]?.state).toBe("modified");

    // After re-install, drift is empty.
    installSkills({ baseDir, scope: "claude", skills: bundled() });
    expect(detectDrift({ baseDir, scope: "claude", skills: bundled() })).toEqual([]);
  });
});

describe("orphanStatuses / pruneSkills (#556)", () => {
  /** Plant a mirror directory under a host dir, bypassing installSkills. */
  function plantMirror(host: "claude" | "agents", name: string, body = `# ${name}\n`): string {
    const target = mirrorPath(baseDir, host, name);
    mkdirSync(join(baseDir, host === "claude" ? ".claude" : ".agents", "skills", name), {
      recursive: true,
    });
    writeFileSync(target, body);
    return target;
  }

  test("a retired-name mirror outside the catalog is reported as orphan", () => {
    installSkills({ baseDir, scope: "claude", skills: bundled() });
    plantMirror("claude", "catchup"); // folded into brief by ADR-0046
    const statuses = skillStatuses({ baseDir, scope: "claude", skills: bundled() });
    const hit = statuses.find((s) => s.name === "catchup");
    expect(hit?.state).toBe("orphan");
    expect(hit?.mirrorPath).toBe(mirrorPath(baseDir, "claude", "catchup"));
    // Catalog rows are unaffected.
    expect(statuses.find((s) => s.name === "next-actions")?.state).toBe("installed");
  });

  test("a catalog name is never an orphan, even when it is also a retired name", () => {
    // The fixture catalog deliberately bundles 'personal-brief' (a RETIRED_SKILLS
    // member): catalog membership must win over the historical list.
    installSkills({ baseDir, scope: "claude", skills: bundled() });
    const statuses = skillStatuses({ baseDir, scope: "claude", skills: bundled() });
    const rows = statuses.filter((s) => s.name === "personal-brief");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe("installed");
  });

  test("a foreign skill dir (ecosystem dev skill) is never reported nor pruned", () => {
    installSkills({ baseDir, scope: "claude", skills: bundled(), version: "1.0.0" });
    const foreign = plantMirror("claude", "drive"); // @ozzylabs/skills namespace
    expect(orphanStatuses({ baseDir, scope: "claude", skills: bundled() })).toEqual([]);
    const pruned = pruneSkills({ baseDir, scope: "claude", skills: bundled() });
    expect(pruned).toEqual([]);
    expect(existsSync(foreign)).toBe(true);
  });

  test("the stamp records installed names and tracks a later-dropped skill as orphan", () => {
    // v1 installs the full fixture catalog; 'next-actions' is not a retired
    // name, so only the stamp record can prove suasor owned it.
    installSkills({ baseDir, scope: "claude", skills: bundled(), version: "1.0.0" });
    expect(readStamp(baseDir, "claude")?.skills).toEqual(["next-actions", "personal-brief"]);

    // v2 drops 'next-actions' from the catalog; its mirror survives install.
    const contracted = bundled().filter((s) => s.name === "personal-brief");
    installSkills({ baseDir, scope: "claude", skills: contracted, version: "2.0.0" });
    expect(readStamp(baseDir, "claude")?.skills).toEqual(["next-actions", "personal-brief"]);
    const orphans = orphanStatuses({ baseDir, scope: "claude", skills: contracted });
    expect(orphans.map((o) => o.name)).toEqual(["next-actions"]);
    expect(orphans[0]?.state).toBe("orphan");

    // Pruning removes the mirror; the next stamp write drops the record.
    pruneSkills({ baseDir, scope: "claude", skills: contracted });
    expect(existsSync(mirrorPath(baseDir, "claude", "next-actions"))).toBe(false);
    installSkills({ baseDir, scope: "claude", skills: contracted, version: "2.0.0" });
    expect(readStamp(baseDir, "claude")?.skills).toEqual(["personal-brief"]);
    expect(orphanStatuses({ baseDir, scope: "claude", skills: contracted })).toEqual([]);
  });

  test("pruneSkills drops pruned names from the stamp roster so a later hand-placed dir is safe", () => {
    // v1 installs both fixture skills; v2 drops 'next-actions' (not a retired
    // name — the stamp roster is the only ownership evidence).
    installSkills({ baseDir, scope: "claude", skills: bundled(), version: "1.0.0" });
    const contracted = bundled().filter((s) => s.name === "personal-brief");
    installSkills({ baseDir, scope: "claude", skills: contracted, version: "2.0.0" });
    pruneSkills({ baseDir, scope: "claude", skills: contracted });

    // The roster no longer claims the pruned name...
    expect(readStamp(baseDir, "claude")?.skills).toEqual(["personal-brief"]);
    // ...so a user skill later hand-placed under that name is never a candidate.
    const handPlaced = plantMirror("claude", "next-actions", "# my own skill\n");
    expect(orphanStatuses({ baseDir, scope: "claude", skills: contracted })).toEqual([]);
    expect(pruneSkills({ baseDir, scope: "claude", skills: contracted })).toEqual([]);
    expect(existsSync(handPlaced)).toBe(true);
  });

  test("pruneSkills removes the orphan mirror dir; dryRun only reports", () => {
    installSkills({ baseDir, skills: bundled() });
    const claudeMirror = plantMirror("claude", "weekly-review");
    const agentsMirror = plantMirror("agents", "weekly-review");

    const dry = pruneSkills({ baseDir, dryRun: true, skills: bundled() });
    expect(dry.map((r) => r.removed)).toEqual([false, false]);
    expect(existsSync(claudeMirror)).toBe(true);
    expect(existsSync(agentsMirror)).toBe(true);

    const wet = pruneSkills({ baseDir, skills: bundled() });
    expect(wet.map((r) => r.removed)).toEqual([true, true]);
    expect(existsSync(join(baseDir, ".claude", "skills", "weekly-review"))).toBe(false);
    expect(existsSync(join(baseDir, ".agents", "skills", "weekly-review"))).toBe(false);
    // Catalog mirrors are untouched.
    expect(existsSync(mirrorPath(baseDir, "claude", "next-actions"))).toBe(true);
  });

  test("a directory without SKILL.md is not a mirror and never an orphan", () => {
    mkdirSync(join(baseDir, ".claude", "skills", "catchup"), { recursive: true });
    expect(orphanStatuses({ baseDir, scope: "claude", skills: bundled() })).toEqual([]);
  });

  test("detectDrift surfaces orphans alongside missing / modified", () => {
    installSkills({ baseDir, scope: "claude", skills: bundled() });
    plantMirror("claude", "catchup");
    const drift = detectDrift({ baseDir, scope: "claude", skills: bundled() });
    expect(drift.map((d) => `${d.name}:${d.state}`)).toEqual(["catchup:orphan"]);
  });
});

describe("real bundled catalog", () => {
  test("the shipped docs/skills resolves and is non-empty", () => {
    const src = resolveSkillsSource();
    expect(src).not.toBeNull();
    const skills = listBundledSkills(src);
    expect(skills.length).toBeGreaterThanOrEqual(20);
    expect(skills.map((s) => s.name)).toContain("brief");
  });

  test("ships the merged read entry points (ADR-0046)", () => {
    const names = listBundledSkills(resolveSkillsSource()).map((s) => s.name);
    for (const merged of ["brief", "source-review", "find", "meeting", "decisions", "draft"]) {
      expect(names).toContain(merged);
    }
    // The folded-away names must be gone, not shadowed by a leftover directory.
    for (const gone of ["personal-brief", "doc-review", "find-document", "meeting-prep"]) {
      expect(names).not.toContain(gone);
    }
    expect(names).toContain("plan-draft"); // write-side draft stays separate
  });

  test("ships the task-update lifecycle skill", () => {
    const names = listBundledSkills(resolveSkillsSource()).map((s) => s.name);
    expect(names).toContain("task-update");
  });

  test("ships the ledger / identity HITL skills (commitment / proposal / person)", () => {
    const names = listBundledSkills(resolveSkillsSource()).map((s) => s.name);
    expect(names).toContain("commitment-review");
    expect(names).toContain("proposal-review");
    expect(names).toContain("person-cleanup");
  });

  test("ships the Slack-triage and provenance-trace read skills", () => {
    const names = listBundledSkills(resolveSkillsSource()).map((s) => s.name);
    expect(names).toContain("slack-triage");
    expect(names).toContain("provenance-trace");
  });

  test("ships the active-surface read skills (commitment-chase / next-actions)", () => {
    const names = listBundledSkills(resolveSkillsSource()).map((s) => s.name);
    expect(names).toContain("commitment-chase");
    expect(names).toContain("next-actions");
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
