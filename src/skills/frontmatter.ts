/**
 * Assistant-skill frontmatter schema + parser (ADR-0032, extends ADR-0008).
 *
 * Each `docs/skills/<name>/SKILL.md` opens with a YAML frontmatter block. ADR-0008
 * established the required `name` / `description` (free-text trigger). ADR-0032
 * adds backward-compatible machine-readable fields (`readOnly`, `category`,
 * `triggers[]`, `pairs[]`, optional `mcp_tools_read/write[]`) so hosts and the CLI
 * can reason about a skill (read-vs-write boundary, category, trigger phrases,
 * paired skill) instead of grepping prose.
 *
 * Backward compatibility (ADR-0032 §(a)):
 * - Unknown frontmatter keys are tolerated (`.passthrough()`), so existing mirrors and
 *   host parsers never break when fields are added.
 * - Only `name` / `description` are schema-required; `readOnly` / `category` are
 *   optional in the type but enforced across all bundled skills by the validator
 *   test (`tests/skills/frontmatter.test.ts`).
 *
 * No heavy dependencies: a tiny self-contained YAML-subset parser (the frontmatter
 * we author is flat scalars + simple string arrays) + Zod, so the CLI can
 * lazy-load this cheaply (NFR-PRF-1, ADR-0008).
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { BundledSkill } from "./catalog.ts";

/** Closed set of skill categories (ADR-0032 §(b)). Extend only with an ADR update. */
export const SKILL_CATEGORIES = [
  "brief",
  "retrieval",
  "meeting",
  "decision",
  "review",
  "draft",
  "triage",
  "commitment",
  "task",
  "graph",
  "identity",
  "planning",
] as const;
export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

/**
 * Zod schema for a skill's frontmatter (ADR-0032 §(a)).
 *
 * `name` / `description` are required (ADR-0008). The remaining fields are
 * optional for forward/backward compatibility, but the validator test asserts
 * every bundled skill carries `readOnly` + `category`. `.passthrough()` tolerates
 * unknown keys so the schema never rejects a legacy or newer frontmatter.
 */
export const SkillFrontmatter = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    readOnly: z.boolean().optional(),
    category: z.enum(SKILL_CATEGORIES).optional(),
    triggers: z.array(z.string().min(1)).optional(),
    pairs: z.array(z.string().min(1)).optional(),
    mcp_tools_read: z.array(z.string().min(1)).optional(),
    mcp_tools_write: z.array(z.string().min(1)).optional(),
  })
  .passthrough();
export type SkillFrontmatter = z.infer<typeof SkillFrontmatter>;

/**
 * Extract the raw YAML frontmatter block (between the leading `---` fences).
 *
 * Returns the inner text (without the fences), or `null` when the document does
 * not start with a frontmatter block.
 */
export function extractFrontmatterBlock(md: string): string | null {
  // Frontmatter must be the very first thing in the file (allow a leading BOM).
  const text = md.startsWith("﻿") ? md.slice(1) : md;
  if (!text.startsWith("---")) return null;
  // Match the opening fence and the next line that is exactly `---`.
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return match ? (match[1] ?? "") : null;
}

/** Strip a surrounding pair of single or double quotes from a scalar value. */
function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Parse the frontmatter of a SKILL.md into a plain object.
 *
 * Supports the YAML subset we author: top-level `key: scalar` and string arrays
 * in either flow form (`key: [a, b]`) or block form (`key:` then `  - a`).
 * `readOnly: true|false` is coerced to boolean. Returns `{}` when no frontmatter
 * block is present (so callers can let the schema flag the missing required keys).
 */
export function parseFrontmatter(md: string): Record<string, unknown> {
  const block = extractFrontmatterBlock(md);
  if (block === null) return {};

  const out: Record<string, unknown> = {};
  const lines = block.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      i++;
      continue;
    }
    const kv = line.match(/^([A-Za-z_][\w-]*):(.*)$/);
    if (!kv || kv[1] === undefined) {
      i++;
      continue;
    }
    const key = kv[1];
    const rest = (kv[2] ?? "").trim();

    if (rest === "") {
      // Block-form array: subsequent `  - item` lines.
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const item = (lines[j] ?? "").match(/^\s*-\s+(.*)$/);
        if (!item || item[1] === undefined) break;
        items.push(unquote(item[1]));
        j++;
      }
      out[key] = items;
      i = j;
      continue;
    }

    if (rest.startsWith("[") && rest.endsWith("]")) {
      // Flow-form array: [a, b, c] (empty `[]` → []).
      const inner = rest.slice(1, -1).trim();
      out[key] = inner === "" ? [] : inner.split(",").map((s) => unquote(s));
      i++;
      continue;
    }

    if (rest === "true" || rest === "false") {
      out[key] = rest === "true";
      i++;
      continue;
    }

    out[key] = unquote(rest);
    i++;
  }
  return out;
}

/** A parse/validation failure with the offending skill name for context. */
export class SkillFrontmatterError extends Error {
  constructor(
    readonly skillName: string,
    message: string,
  ) {
    super(`skill '${skillName}': ${message}`);
    this.name = "SkillFrontmatterError";
  }
}

/**
 * Parse + validate a SKILL.md frontmatter string against the schema.
 *
 * Returns a discriminated result so callers (validator test, CLI) can surface
 * detailed errors without throwing on the hot path.
 */
export function validateFrontmatter(
  md: string,
): { ok: true; value: SkillFrontmatter } | { ok: false; error: string } {
  const raw = parseFrontmatter(md);
  const parsed = SkillFrontmatter.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((iss) => `${iss.path.join(".") || "(root)"}: ${iss.message}`)
      .join("; ");
    return { ok: false, error: issues };
  }
  return { ok: true, value: parsed.data };
}

/** A bundled skill paired with its validated frontmatter. */
export interface SkillInfo {
  readonly name: string;
  readonly sourcePath: string;
  readonly frontmatter: SkillFrontmatter;
}

/**
 * Read + parse + validate one bundled skill's frontmatter.
 *
 * Throws `SkillFrontmatterError` when the frontmatter is missing required fields
 * or otherwise fails the schema.
 */
export function loadSkillFrontmatter(skill: BundledSkill): SkillInfo {
  const md = readFileSync(skill.sourcePath, "utf8");
  const result = validateFrontmatter(md);
  if (!result.ok) {
    throw new SkillFrontmatterError(skill.name, result.error);
  }
  return { name: skill.name, sourcePath: skill.sourcePath, frontmatter: result.value };
}

/** Load + validate frontmatter for a list of bundled skills (sorted by name). */
export function loadSkillInfos(skills: readonly BundledSkill[]): SkillInfo[] {
  return skills.map(loadSkillFrontmatter);
}

/**
 * Case-insensitive substring search over a skill's name, category, description
 * and trigger phrases (ADR-0032 §(d), `skills search`).
 */
export function skillMatchesQuery(info: SkillInfo, query: string): boolean {
  const q = query.toLowerCase();
  const fm = info.frontmatter;
  const haystacks: string[] = [
    info.name,
    fm.description,
    fm.category ?? "",
    ...(fm.triggers ?? []),
  ];
  return haystacks.some((h) => h.toLowerCase().includes(q));
}
