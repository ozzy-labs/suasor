/**
 * `suasor skills search` / `skills info` / `skills list --format=detailed`
 * (ADR-0032). Drives the real CLI against the bundled catalog and asserts the
 * new discovery surface, plus a regression that `--json` keeps its established
 * shapes.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCli } from "../../src/cli/index.ts";

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
    expect(out).toContain("meeting-prep");
    expect(out).toContain("meeting-followup");
    expect(out).toContain("read");
    expect(out).toContain("write");
    expect(out).toContain("match(es)");
  });

  test("matches a trigger phrase", async () => {
    const { code, out } = await run(["skills", "search", "引き継ぎ"]);
    expect(code).toBe(0);
    expect(out).toContain("handoff-draft");
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
    const { code, out } = await run(["skills", "info", "research", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as { name: string; category: string; readOnly: boolean };
    expect(parsed.name).toBe("research");
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
    expect(out).toContain("personal-brief");
  });

  test("compact (default) keeps the original status-only rows", async () => {
    const { code, out } = await run(["skills", "list", "--scope", "claude"]);
    expect(code).toBe(0);
    expect(out).toContain("personal-brief");
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
