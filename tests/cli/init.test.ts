/**
 * `suasor init` CLI wiring (first-run setup: config + DB init, docs/design/cli.md).
 * Runs end-to-end against a temp config dir so the seed config.toml + the on-disk
 * SQLite store are really created. The critical onboarding path: a fresh `init`
 * must succeed, be safe to re-run (idempotent), and never clobber an existing
 * config without `--force` (Issue #268).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCli } from "../../src/cli/index.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "suasor-cli-init-"));
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

describe("suasor init", () => {
  test("--help lists the init command", async () => {
    const { code, out } = await run(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("init");
  });

  test("a fresh dir: seeds config.toml, initializes the DB, prints next steps", async () => {
    const { code, out } = await run(["init"]);
    expect(code).toBe(0);

    // Config + DB are really written to the temp dir.
    const configPath = join(dir, "config.toml");
    expect(existsSync(configPath)).toBe(true);
    expect(existsSync(join(dir, "suasor.db"))).toBe(true);

    // The output guides the user: wrote config, initialized DB, next steps.
    expect(out).toContain("Wrote default config");
    expect(out).toContain("Initialized database");
    expect(out).toContain("Next steps:");
    expect(out).toContain("suasor doctor");

    // The seeded config carries the documented default sections.
    const seeded = readFileSync(configPath, "utf8");
    expect(seeded).toContain("[storage]");
    expect(seeded).toContain('backend = "disabled"');
  });

  test("the seeded template's comments do not mislead (Issue #294)", async () => {
    const { code } = await run(["init"]);
    expect(code).toBe(0);
    const seeded = readFileSync(join(dir, "config.toml"), "utf8");
    // [llm].backend is documented as accepted-but-unused (host-delegated, ADR-0006).
    expect(seeded).toContain("NOT read by the runtime");
    expect(seeded).toContain("ADR-0006");
    // The embedding dim comment lists the per-backend model dimensions so a backend
    // switch does not silently degrade recall.
    expect(seeded).toContain("text-embedding-3-small=1536");
    expect(seeded).toContain("voyage-3=1024");
    // …and warns that dim must match the existing DB's vec0 width.
    expect(seeded).toContain("vec0 width");
  });

  test("re-running is idempotent: keeps the existing config, still exits 0", async () => {
    const first = await run(["init"]);
    expect(first.code).toBe(0);

    // A user edit the second run must not clobber (no --force).
    const configPath = join(dir, "config.toml");
    await Bun.write(configPath, `[storage]\ndbPath = "${join(dir, "custom.db")}"\n`);

    const second = await run(["init"]);
    expect(second.code).toBe(0);
    expect(second.out).toContain("Config already exists");
    expect(second.out).not.toContain("Wrote default config");

    // The user's edited config survives; the DB it points at is initialized.
    const after = readFileSync(configPath, "utf8");
    expect(after).toContain("custom.db");
    expect(existsSync(join(dir, "custom.db"))).toBe(true);
  });

  test("--force overwrites an existing config.toml with the default template", async () => {
    const configPath = join(dir, "config.toml");
    await Bun.write(configPath, "[storage]\n# hand-written marker\n");

    const { code, out } = await run(["init", "--force"]);
    expect(code).toBe(0);
    expect(out).toContain("Overwrote default config");

    const after = readFileSync(configPath, "utf8");
    expect(after).not.toContain("hand-written marker");
    expect(after).toContain("Precedence: init args > env");
  });
});
