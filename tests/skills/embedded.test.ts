/**
 * The embedded skill catalog (ADR-0008 / ADR-0010, Issue #445): the standalone
 * binary carries `docs/skills` as source because `--compile` embeds only what
 * the module graph statically references.
 *
 * The drift test below is what keeps the generated module honest — the release
 * workflow compiles from the tagged tree with a bare `bun build --compile`, so
 * nothing regenerates it at build time. Add / rename / edit a skill without
 * running `node scripts/generate-embedded-skills.mjs` and this fails.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { EMBEDDED_SKILLS } from "../../src/skills/embedded.ts";
import {
  embeddedSourceLabel,
  listBundledSkills,
  listEmbeddedSkills,
  readSkillSource,
  resolveSkillsSource,
} from "../../src/skills/index.ts";

/** Read `docs/skills` straight from disk (the SSOT the generator mirrors). */
function skillsOnDisk(): Map<string, string> {
  const dir = resolveSkillsSource();
  if (dir === null) throw new Error("docs/skills not found");
  const out = new Map<string, string>();
  for (const name of readdirSync(dir).sort()) {
    const skillDir = join(dir, name);
    if (!statSync(skillDir).isDirectory()) continue;
    try {
      out.set(name, readFileSync(join(skillDir, "SKILL.md"), "utf8"));
    } catch {
      // not a skill (no SKILL.md) — same rule as catalog.ts
    }
  }
  return out;
}

describe("embedded skill catalog (#445)", () => {
  test("is in sync with docs/skills — regenerate on drift", () => {
    const disk = skillsOnDisk();
    expect(Object.keys(EMBEDDED_SKILLS).sort()).toEqual([...disk.keys()].sort());
    for (const [name, body] of disk) {
      // A mismatch here means the SSOT changed without regenerating:
      //   node scripts/generate-embedded-skills.mjs
      expect(EMBEDDED_SKILLS[name]).toBe(body);
    }
  });

  test("is non-empty (the binary fallback would otherwise throw)", () => {
    expect(Object.keys(EMBEDDED_SKILLS).length).toBeGreaterThan(0);
  });

  test("listEmbeddedSkills yields sorted, embedded-tagged entries", () => {
    const skills = listEmbeddedSkills();
    expect(skills.map((s) => s.name)).toEqual([...skills.map((s) => s.name)].sort());
    expect(skills.every((s) => s.embedded === true)).toBe(true);
    const first = skills[0];
    expect(first?.sourcePath).toBe(embeddedSourceLabel(first?.name ?? ""));
  });

  test("readSkillSource returns the same body from disk and from the embedding", () => {
    const [onDisk] = listBundledSkills();
    if (!onDisk) throw new Error("no bundled skill on disk");
    const embedded = {
      name: onDisk.name,
      sourcePath: embeddedSourceLabel(onDisk.name),
      embedded: true,
    };
    expect(readSkillSource(embedded)).toBe(readSkillSource(onDisk));
  });

  test("readSkillSource throws a named error for an unknown embedded skill", () => {
    expect(() =>
      readSkillSource({ name: "no-such-skill", sourcePath: "<embedded>", embedded: true }),
    ).toThrow(/no-such-skill/);
  });

  test("listBundledSkills falls back to the embedding when no source dir exists", () => {
    // `null` is what resolveSkillsSource() returns inside the compiled binary.
    const skills = listBundledSkills(null);
    expect(skills.length).toBe(Object.keys(EMBEDDED_SKILLS).length);
    expect(skills.every((s) => s.embedded === true)).toBe(true);
    // …and the bodies are readable through the same seam the installer uses.
    expect(readSkillSource(skills[0] as (typeof skills)[number]).length).toBeGreaterThan(0);
  });
});
