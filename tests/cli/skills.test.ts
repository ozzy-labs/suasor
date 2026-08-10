/**
 * `suasor skills search` / `skills info` / `skills list --format=detailed`
 * (ADR-0032). Drives the real CLI against the bundled catalog and asserts the
 * new discovery surface, plus a regression that `--json` keeps its established
 * shapes.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCli } from "../../src/cli/index.ts";
import { VERSION } from "../../src/version.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "suasor-skills-cli-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const prev = process.env.SUASOR_CONFIG_DIR;
  process.env.SUASOR_CONFIG_DIR = dir;
  let out = "";
  let err = "";
  const cli = buildCli();
  try {
    const code = await cli.run(args, {
      stdin: process.stdin,
      stdout: {
        write: (s: string) => {
          out += s;
          return true;
        },
      } as NodeJS.WriteStream,
      stderr: {
        write: (s: string) => {
          err += s;
          return true;
        },
      } as NodeJS.WriteStream,
      env: process.env,
      colorDepth: 1,
    });
    return { code, out, err };
  } finally {
    if (prev === undefined) delete process.env.SUASOR_CONFIG_DIR;
    else process.env.SUASOR_CONFIG_DIR = prev;
  }
}

describe("suasor skills search", () => {
  test("finds skills by category keyword with read/write boundary", async () => {
    const { code, out } = await run(["skills", "search", "meeting"]);
    expect(code).toBe(0);
    expect(out).toContain("meeting");
    expect(out).toContain("meeting-followup");
    expect(out).toContain("read");
    expect(out).toContain("write");
    expect(out).toContain("match(es)");
  });

  test("matches a trigger phrase", async () => {
    const { code, out } = await run(["skills", "search", "引き継ぎ"]);
    expect(code).toBe(0);
    expect(out).toContain("draft");
  });

  test("reports no matches gracefully", async () => {
    const { code, out } = await run(["skills", "search", "zzz-nonexistent-zzz"]);
    expect(code).toBe(0);
    expect(out).toContain("No skills match");
  });

  test("--json emits objects with name + frontmatter fields", async () => {
    const { code, out } = await run(["skills", "search", "next-actions", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as Array<{
      name: string;
      category?: string;
      readOnly?: boolean;
    }>;
    const hit = parsed.find((p) => p.name === "next-actions");
    expect(hit).toBeDefined();
    expect(hit?.category).toBe("task");
    expect(hit?.readOnly).toBe(true);
  });
});

describe("suasor skills info", () => {
  test("prints category, boundary, triggers and mcp tools for a read skill", async () => {
    const { code, out } = await run(["skills", "info", "next-actions"]);
    expect(code).toBe(0);
    expect(out).toContain("name:");
    expect(out).toContain("category:    task");
    expect(out).toContain("read (autonomous)");
    expect(out).toContain("task.list");
  });

  test("marks a write skill as HITL", async () => {
    const { code, out } = await run(["skills", "info", "reply-draft"]);
    expect(code).toBe(0);
    expect(out).toContain("write (HITL)");
    expect(out).toContain("propose.apply");
  });

  test("errors on an unknown skill name", async () => {
    const { code, err } = await run(["skills", "info", "no-such-skill"]);
    expect(code).toBe(1);
    expect(err).toContain("unknown skill");
  });

  test("--json emits the frontmatter with name", async () => {
    const { code, out } = await run(["skills", "info", "find", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as { name: string; category: string; readOnly: boolean };
    expect(parsed.name).toBe("find");
    expect(parsed.category).toBe("retrieval");
    expect(parsed.readOnly).toBe(true);
  });
});

describe("suasor skills list --format", () => {
  test("detailed adds category + read/write columns", async () => {
    const { code, out } = await run(["skills", "list", "--format=detailed", "--scope", "claude"]);
    expect(code).toBe(0);
    expect(out).toContain("brief");
    expect(out).toContain("write");
    expect(out).toContain("read");
    expect(out).toContain("decisions");
  });

  test("compact (default) keeps the original status-only rows", async () => {
    const { code, out } = await run(["skills", "list", "--scope", "claude"]);
    expect(code).toBe(0);
    expect(out).toContain("brief");
    // No read/write boundary column in compact mode.
    expect(out).not.toMatch(/\bwrite\b/);
  });

  test("rejects an invalid --format", async () => {
    const { code, err } = await run(["skills", "list", "--format=bogus"]);
    expect(code).toBe(1);
    expect(err).toContain("invalid --format");
  });

  test("--json keeps the established SkillStatus[] shape", async () => {
    const { code, out } = await run(["skills", "list", "--scope", "claude", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as Array<{ name: string; host: string; state: string }>;
    expect(parsed.length).toBeGreaterThan(0);
    // Status shape only — no frontmatter fields leaked into the JSON.
    expect(parsed[0]).toHaveProperty("state");
    expect(parsed[0]).not.toHaveProperty("category");
  });
});

describe("suasor skills install — scope + version stamp (#445)", () => {
  test("--host writes mirrors and stamps the host dirs with the running version", async () => {
    const { code, out } = await run(["skills", "install", "--host", dir, "--scope", "claude"]);
    expect(code).toBe(0);
    expect(out).toContain("wrote");
    // The mirror is byte-identical to the SSOT (the stamp lives beside it, not
    // inside it — otherwise drift detection would flag every skill).
    const { listBundledSkills, readSkillSource, mirrorPath, readStamp } = await import(
      "../../src/skills/index.ts"
    );
    const [skill] = listBundledSkills();
    if (!skill) throw new Error("no bundled skill");
    expect(readFileSync(mirrorPath(dir, "claude", skill.name), "utf8")).toBe(
      readSkillSource(skill),
    );
    const stamp = readStamp(dir, "claude");
    expect(stamp?.version).toBe(VERSION);
    expect(stamp?.installedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("--dry-run writes neither mirrors nor a stamp", async () => {
    const { code, out } = await run([
      "skills",
      "install",
      "--host",
      dir,
      "--scope",
      "claude",
      "--dry-run",
    ]);
    expect(code).toBe(0);
    expect(out).toContain("would write");
    const { readStamp } = await import("../../src/skills/index.ts");
    expect(readStamp(dir, "claude")).toBeNull();
    expect(existsSync(join(dir, ".claude", "skills"))).toBe(false);
  });

  test("a user-authored skill at a catalog name is skipped and only --force overwrites (#563)", async () => {
    // The user's own 'find' skill predates any suasor install here.
    const mine = join(dir, ".claude", "skills", "find", "SKILL.md");
    mkdirSync(join(dir, ".claude", "skills", "find"), { recursive: true });
    writeFileSync(mine, "# my find\n");

    const first = await run(["skills", "install", "--host", dir, "--scope", "claude"]);
    expect(first.code).toBe(0);
    expect(first.out).toContain("skipped (not installed by suasor)");
    expect(first.out).toContain("1 skipped");
    expect(first.err).toContain("--force");
    expect(readFileSync(mine, "utf8")).toBe("# my find\n");
    // The stamp record must not claim the skipped name.
    const { readStamp } = await import("../../src/skills/index.ts");
    expect(readStamp(dir, "claude")?.skills).not.toContain("find");

    const forced = await run(["skills", "install", "--host", dir, "--scope", "claude", "--force"]);
    expect(forced.code).toBe(0);
    expect(forced.err).not.toContain("--force");
    expect(readFileSync(mine, "utf8")).not.toBe("# my find\n");
    expect(readStamp(dir, "claude")?.skills).toContain("find");
  });

  test("skills list warns once when the installed mirrors carry another version", async () => {
    await run(["skills", "install", "--host", dir, "--scope", "claude"]);
    // Rewrite the stamp as if an older suasor had installed them.
    const { stampPath } = await import("../../src/skills/index.ts");
    writeFileSync(
      stampPath(dir, "claude"),
      JSON.stringify({ version: "0.0.1-old", installedAt: "2020-01-01T00:00:00.000Z" }),
    );
    const { code, err } = await run(["skills", "list", "--host", dir, "--scope", "claude"]);
    expect(code).toBe(0);
    expect(err).toContain("another suasor version");
    expect(err).toContain("0.0.1-old");
    expect(err).toContain("skills install");
  });

  test("orphaned mirrors are detected, warned about, and pruned (#556)", async () => {
    await run(["skills", "install", "--host", dir, "--scope", "claude"]);
    // A retired mirror left behind by a pre-ADR-0046 install, plus a foreign
    // ecosystem dev skill that must never be touched.
    for (const name of ["personal-brief", "drive"]) {
      mkdirSync(join(dir, ".claude", "skills", name), { recursive: true });
      writeFileSync(join(dir, ".claude", "skills", name, "SKILL.md"), `# ${name}\n`);
    }

    // list appends the orphan row + summary count and points at prune.
    const list = await run(["skills", "list", "--host", dir, "--scope", "claude"]);
    expect(list.code).toBe(0);
    expect(list.out).toContain("orphan");
    expect(list.out).toContain("personal-brief");
    expect(list.out).toContain("1 orphan");
    expect(list.err).toContain("skills prune");
    expect(list.out).not.toContain("drive"); // foreign dir: not even reported

    // install re-run warns (cleanup signal) but removes nothing by itself.
    const install = await run(["skills", "install", "--host", dir, "--scope", "claude"]);
    expect(install.code).toBe(0);
    expect(install.err).toContain("outside the catalog");
    expect(install.err).toContain("personal-brief");
    expect(install.err).toContain("skills prune");
    expect(existsSync(join(dir, ".claude", "skills", "personal-brief", "SKILL.md"))).toBe(true);

    // --dry-run previews without deleting.
    const dry = await run(["skills", "prune", "--host", dir, "--scope", "claude", "--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("would remove");
    expect(existsSync(join(dir, ".claude", "skills", "personal-brief", "SKILL.md"))).toBe(true);

    // prune removes the orphan, leaves the foreign dev skill alone.
    const prune = await run(["skills", "prune", "--host", dir, "--scope", "claude"]);
    expect(prune.code).toBe(0);
    expect(prune.out).toContain("removed");
    expect(prune.out).toContain("personal-brief");
    expect(existsSync(join(dir, ".claude", "skills", "personal-brief"))).toBe(false);
    expect(existsSync(join(dir, ".claude", "skills", "drive", "SKILL.md"))).toBe(true);

    // Idempotent: a second prune finds nothing.
    const again = await run(["skills", "prune", "--host", dir, "--scope", "claude"]);
    expect(again.code).toBe(0);
    expect(again.out).toContain("No orphaned mirrors found");
  });

  test("skills prune --json emits PruneResult[] and rejects an invalid --scope", async () => {
    await run(["skills", "install", "--host", dir, "--scope", "claude"]);
    mkdirSync(join(dir, ".claude", "skills", "doc-review"), { recursive: true });
    writeFileSync(join(dir, ".claude", "skills", "doc-review", "SKILL.md"), "# doc-review\n");

    const { code, out } = await run(["skills", "prune", "--host", dir, "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as Array<{
      name: string;
      host: string;
      mirrorPath: string;
      removed: boolean;
    }>;
    expect(parsed).toEqual([
      {
        name: "doc-review",
        host: "claude",
        mirrorPath: join(dir, ".claude", "skills", "doc-review", "SKILL.md"),
        removed: true,
      },
    ]);

    const bad = await run(["skills", "prune", "--scope", "bogus"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("invalid --scope");
  });

  test("skills list is quiet when the stamp matches, and when nothing is installed", async () => {
    // Nothing installed → not "stale", just absent (no nagging).
    const fresh = await run(["skills", "list", "--host", dir, "--scope", "claude"]);
    expect(fresh.err).not.toContain("another suasor version");
    // Installed by this build → current.
    await run(["skills", "install", "--host", dir, "--scope", "claude"]);
    const after = await run(["skills", "list", "--host", dir, "--scope", "claude"]);
    expect(after.err).not.toContain("another suasor version");
  });
});
