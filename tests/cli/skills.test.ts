/**
 * `suasor skills search` / `skills info` / `skills list --format=detailed`
 * (ADR-0032). Drives the real CLI against the bundled catalog and asserts the
 * new discovery surface, plus a regression that `--json` keeps its established
 * shapes.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
