#!/usr/bin/env node
/**
 * Generate `src/skills/embedded.ts` — the bundled assistant-skill catalog
 * inlined as source (ADR-0008 / ADR-0010, Issue #445).
 *
 * Why a generated module: the standalone binary (`bun build --compile`) has no
 * `docs/skills` directory to read — the filesystem lookup that serves the repo
 * and the npm package returns nothing there, so `skills install / list / search
 * / info` were gated off entirely, leaving the "no JS toolchain" persona with a
 * CLI that cannot ship its own skills. `--compile` only embeds what the module
 * graph statically references, so the catalog has to exist as code.
 *
 * The output is committed (not gitignored): the release workflow compiles the
 * binary straight from the tagged tree with a bare `bun build --compile`, so a
 * build-time generation step would never run there. `tests/skills/embedded.test.ts`
 * regenerates in-memory and fails on drift, which is what keeps the committed
 * copy honest when a skill is added, renamed, or edited.
 *
 * Usage: `node scripts/generate-embedded-skills.mjs [--check]`
 *   --check  exit 1 without writing when the committed file is out of date
 *
 * No dependencies beyond Node's standard library (mirrors scripts/postinstall.mjs).
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillsDir = join(repoRoot, "docs", "skills");
const outPath = join(repoRoot, "src", "skills", "embedded.ts");
const SKILL_FILE = "SKILL.md";

/** Every `docs/skills/<name>/SKILL.md`, sorted by name (deterministic output). */
function collect() {
  const entries = [];
  for (const name of readdirSync(skillsDir).sort()) {
    const dir = join(skillsDir, name);
    if (!statSync(dir).isDirectory()) continue;
    const file = join(dir, SKILL_FILE);
    let content;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue; // a directory without a SKILL.md is not a skill (catalog.ts rule)
    }
    entries.push([name, content]);
  }
  return entries;
}

function render(entries) {
  // JSON.stringify per body: markdown is full of backticks and `${`, so a
  // template literal would need escaping that is easy to get subtly wrong.
  const body = entries
    .map(([name, content]) => `  ${JSON.stringify(name)}: ${JSON.stringify(content)},`)
    .join("\n");
  return `/**
 * Bundled assistant-skill catalog, inlined as source (ADR-0008, Issue #445).
 *
 * GENERATED FILE — do not edit by hand. Regenerate with:
 *
 *     node scripts/generate-embedded-skills.mjs
 *
 * The SSOT is \`docs/skills/<name>/SKILL.md\`; this module exists so the
 * standalone binary (\`bun build --compile\`, which embeds only what the module
 * graph statically references) carries the same catalog the repo and the npm
 * package read from disk. \`tests/skills/embedded.test.ts\` fails on drift.
 */

/** skill name → the verbatim contents of its \`SKILL.md\`. */
export const EMBEDDED_SKILLS: Readonly<Record<string, string>> = {
${body}
};
`;
}

const generated = render(collect());
const check = process.argv.includes("--check");
if (check) {
  let current = "";
  try {
    current = readFileSync(outPath, "utf8");
  } catch {
    // treated as drift below
  }
  if (current !== generated) {
    process.stderr.write(
      "src/skills/embedded.ts is out of date — run `node scripts/generate-embedded-skills.mjs`\n",
    );
    process.exit(1);
  }
  process.exit(0);
}
writeFileSync(outPath, generated);
process.stdout.write(`wrote ${outPath}\n`);
