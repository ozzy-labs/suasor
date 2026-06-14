/**
 * Cold-start / lazy-import discipline (NFR-PRF-1, docs/design/cli.md).
 *
 * Building the CLI registry must not pull in heavy dependencies (the DB layer,
 * drizzle, sqlite-vec, or the config loader). Each command lazy-imports its
 * heavy work inside `execute`. We enforce this two ways:
 *  1. A static guard over the CLI sources: their *top-level* imports must not
 *     reference heavy modules (those belong inside `execute`).
 *  2. A runtime guard: building the CLI in a fresh subprocess must not register
 *     the `bun:sqlite` / drizzle / sqlite-vec modules in the module cache.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliDir = join(here, "../../src/cli");

/** Modules that must only ever be imported lazily (inside `execute`). */
const HEAVY = [
  "bun:sqlite",
  "drizzle-orm",
  "sqlite-vec",
  "../../db",
  "../../config",
  "../db",
  "../config",
];

/** Collect every .ts file under the CLI dir (entry + commands). */
function cliSources(): string[] {
  const files: string[] = [join(cliDir, "index.ts")];
  for (const name of readdirSync(join(cliDir, "commands"))) {
    if (name.endsWith(".ts")) files.push(join(cliDir, "commands", name));
  }
  return files;
}

describe("CLI lazy-import discipline", () => {
  test("no top-level static import of heavy modules in CLI sources", async () => {
    const offenders: string[] = [];
    for (const file of cliSources()) {
      const text = await Bun.file(file).text();
      // Static `import ... from "x"` statements live before any function body;
      // dynamic `await import("x")` inside `execute` is allowed and uses `(`.
      const staticImports = text.matchAll(/^import\s[^\n]*from\s+["']([^"']+)["'];?/gm);
      for (const m of staticImports) {
        const spec = m[1] ?? "";
        if (HEAVY.some((h) => spec === h || spec.startsWith(`${h}/`))) {
          offenders.push(`${file}: ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("building the CLI registry does not load the DB / sqlite modules", () => {
    // Fresh subprocess: import the CLI entry, build the registry, then report
    // which heavy modules ended up in Bun's module registry. Run out-of-process
    // so this test's own imports (which include the DB layer transitively via
    // the command modules' `execute`) don't pollute the measurement.
    const probeDir = mkdtempSync(join(tmpdir(), "suasor-lazy-"));
    try {
      const probePath = join(probeDir, "probe.ts");
      writeFileSync(
        probePath,
        `import { buildCli } from ${JSON.stringify(join(cliDir, "index.ts"))};
buildCli();
const reg = globalThis.Loader?.registry;
const keys = reg ? (reg instanceof Map ? [...reg.keys()] : Object.keys(reg)) : null;
const heavy = ["sqlite", "drizzle-orm"];
const hit = keys === null ? null : heavy.filter((h) => keys.some((k) => k.includes(h)));
console.log(JSON.stringify(hit));
`,
      );
      const proc = Bun.spawnSync(["bun", "run", probePath], { env: { ...process.env } });
      expect(proc.exitCode).toBe(0);
      const stdout = proc.stdout.toString().trim();
      const parsed = JSON.parse(stdout) as string[] | null;
      // `null` means the Bun registry was not introspectable in this build; the
      // static guard above still enforces the discipline. Otherwise assert it.
      if (parsed !== null) expect(parsed).toEqual([]);
    } finally {
      rmSync(probeDir, { recursive: true, force: true });
    }
  });
});
