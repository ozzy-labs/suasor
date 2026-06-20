/**
 * Assistant-skill frontmatter schema + validator (ADR-0032).
 *
 * Two layers:
 * 1. Unit tests of the parser/schema against synthetic frontmatter (parse edge
 *    cases, backward compatibility, validation errors).
 * 2. Catalog invariants over the real bundled skills: every SKILL.md carries the
 *    required machine-readable fields, name matches its directory, categories are
 *    in the closed set, pairs are symmetric, and the host mirrors match the SSOT.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { listBundledSkills, resolveSkillsSource } from "../../src/skills/catalog.ts";
import {
  extractFrontmatterBlock,
  loadSkillInfos,
  parseFrontmatter,
  SKILL_CATEGORIES,
  SkillFrontmatter,
  skillMatchesQuery,
  validateFrontmatter,
} from "../../src/skills/frontmatter.ts";
import { mirrorPath } from "../../src/skills/install.ts";

describe("extractFrontmatterBlock", () => {
  test("extracts the block between the leading fences", () => {
    expect(extractFrontmatterBlock("---\nname: x\n---\n# body\n")).toBe("name: x");
  });

  test("returns null when there is no leading frontmatter", () => {
    expect(extractFrontmatterBlock("# just a heading\n")).toBeNull();
  });

  test("tolerates a leading BOM", () => {
    expect(extractFrontmatterBlock("﻿---\nname: x\n---\n")).toBe("name: x");
  });
});

describe("parseFrontmatter", () => {
  test("parses scalars, booleans, flow + block arrays", () => {
    const md = [
      "---",
      "name: demo",
      "description: a prose trigger",
      "readOnly: true",
      "category: brief",
      "triggers:",
      '  - "#123 ask"',
      "  - 次に何",
      "pairs: [other]",
      "mcp_tools_read: []",
      "---",
      "# body",
    ].join("\n");
    const fm = parseFrontmatter(md);
    expect(fm.name).toBe("demo");
    expect(fm.readOnly).toBe(true);
    expect(fm.category).toBe("brief");
    expect(fm.triggers).toEqual(["#123 ask", "次に何"]);
    expect(fm.pairs).toEqual(["other"]);
    expect(fm.mcp_tools_read).toEqual([]);
  });

  test("returns {} when there is no frontmatter", () => {
    expect(parseFrontmatter("no frontmatter here")).toEqual({});
  });
});

describe("SkillFrontmatter schema", () => {
  test("accepts a minimal legacy frontmatter (name + description only)", () => {
    const r = SkillFrontmatter.safeParse({ name: "x", description: "y" });
    expect(r.success).toBe(true);
  });

  test("tolerates unknown keys (forward compatible)", () => {
    const r = SkillFrontmatter.safeParse({ name: "x", description: "y", futureField: 1 });
    expect(r.success).toBe(true);
  });

  test("rejects a missing required field", () => {
    expect(SkillFrontmatter.safeParse({ name: "x" }).success).toBe(false);
  });

  test("rejects an unknown category", () => {
    const r = SkillFrontmatter.safeParse({ name: "x", description: "y", category: "bogus" });
    expect(r.success).toBe(false);
  });

  test("rejects a non-boolean readOnly", () => {
    const r = SkillFrontmatter.safeParse({ name: "x", description: "y", readOnly: "yes" });
    expect(r.success).toBe(false);
  });
});

describe("validateFrontmatter", () => {
  test("reports detailed errors for invalid frontmatter", () => {
    const r = validateFrontmatter("---\nname: x\n---\n");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("description");
  });
});

describe("skillMatchesQuery", () => {
  const info = {
    name: "meeting-prep",
    sourcePath: "/x",
    frontmatter: {
      name: "meeting-prep",
      description: "prep for the next meeting",
      category: "meeting" as const,
      triggers: ["来週の会議準備"],
    },
  };
  test("matches on name, category, description, trigger (case-insensitive)", () => {
    expect(skillMatchesQuery(info, "PREP")).toBe(true);
    expect(skillMatchesQuery(info, "meeting")).toBe(true);
    expect(skillMatchesQuery(info, "会議準備")).toBe(true);
    expect(skillMatchesQuery(info, "nonexistent")).toBe(false);
  });
});

describe("bundled skill catalog invariants (ADR-0032)", () => {
  const infos = loadSkillInfos(listBundledSkills());

  test("there are 26 bundled skills", () => {
    expect(infos.length).toBe(26);
  });

  test("every skill carries readOnly (boolean) + category (enum)", () => {
    for (const info of infos) {
      expect(typeof info.frontmatter.readOnly).toBe("boolean");
      expect(SKILL_CATEGORIES).toContain(
        info.frontmatter.category as (typeof SKILL_CATEGORIES)[number],
      );
    }
  });

  test("frontmatter name matches the directory name", () => {
    for (const info of infos) {
      expect(info.frontmatter.name).toBe(info.name);
    }
  });

  test("pairs are symmetric", () => {
    const byName = new Map(infos.map((i) => [i.name, i]));
    for (const info of infos) {
      for (const partner of info.frontmatter.pairs ?? []) {
        const other = byName.get(partner);
        expect(other, `${info.name} pairs ${partner} which must exist`).toBeDefined();
        expect(other?.frontmatter.pairs ?? []).toContain(info.name);
      }
    }
  });

  test("exactly 17 read-only and 9 write skills (docs/skills/README.md split)", () => {
    const read = infos.filter((i) => i.frontmatter.readOnly === true).length;
    const write = infos.filter((i) => i.frontmatter.readOnly === false).length;
    expect(read).toBe(17);
    expect(write).toBe(9);
  });

  test("host mirrors carry frontmatter identical to the SSOT", () => {
    // mirrorPath resolves under <baseDir>/.claude|.agents; the repo root is the
    // dir holding docs/skills (resolveSkillsSource → docs/skills, two up).
    const skillsRoot = resolveSkillsSource();
    expect(skillsRoot).not.toBeNull();
    const repoRoot = dirname(dirname(skillsRoot as string));
    for (const info of infos) {
      const ssot = readFileSync(info.sourcePath, "utf8");
      for (const host of ["claude", "agents"] as const) {
        const mirror = mirrorPath(repoRoot, host, info.name);
        expect(readFileSync(mirror, "utf8"), `${host} mirror of ${info.name}`).toBe(ssot);
      }
    }
  });
});
