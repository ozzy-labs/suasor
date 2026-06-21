/**
 * `suasor validate-config` CLI wiring (Issue #280). Runs end-to-end against a
 * temp config dir; asserts each finding category is detected, --fix applies the
 * safe removal-only repairs (preserving comments), and exit codes gate.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCli } from "../../src/cli/index.ts";
import { openDatabase } from "../../src/db/index.ts";

let dir: string;
let configPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "suasor-cli-validate-"));
  configPath = join(dir, "config.toml");
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

describe("suasor validate-config", () => {
  test("--help lists the command", async () => {
    const { code, out } = await run(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("validate-config");
  });

  test("errors when config.toml does not exist", async () => {
    const { code, err } = await run(["validate-config"]);
    expect(code).toBe(1);
    expect(err).toContain("no config.toml");
  });

  test("reports invalid TOML and stops", async () => {
    writeFileSync(configPath, "not [[[ valid = = toml", "utf8");
    const { code, err } = await run(["validate-config"]);
    expect(code).toBe(1);
    expect(err).toContain("not valid TOML");
  });

  test("a valid config passes (exit 0)", async () => {
    writeFileSync(
      configPath,
      `[embedding]\nbackend = "disabled"\n[connectors.github]\nrepos = ["owner/repo"]\n`,
      "utf8",
    );
    const { code, out } = await run(["validate-config"]);
    expect(code).toBe(0);
    expect(out).toContain("config is valid");
  });

  test("detects invalid-value (bad enum)", async () => {
    writeFileSync(configPath, '[embedding]\nbackend = "nope"\n', "utf8");
    const { code, out } = await run(["validate-config"]);
    expect(code).toBe(1);
    expect(out).toContain("invalid-value");
    expect(out).toContain("embedding.backend");
  });

  test("detects invalid-value (regex: owner/repo)", async () => {
    writeFileSync(configPath, '[connectors.github]\nrepos = ["no-slash"]\n', "utf8");
    const { code, out } = await run(["validate-config"]);
    expect(code).toBe(1);
    expect(out).toContain("invalid-value");
    expect(out).toContain("connectors.github.repos");
  });

  test("detects unknown-key (typo) and flags it fixable", async () => {
    writeFileSync(configPath, '[connectors.github]\nrepo = ["a/b"]\n', "utf8");
    const { code, out } = await run(["validate-config"]);
    expect(code).toBe(1);
    expect(out).toContain("unknown-key");
    expect(out).toContain("fixable");
  });

  test("detects dangling-reference (missing local root)", async () => {
    writeFileSync(
      configPath,
      `[connectors.local]\nroots = ["${join(dir, "does-not-exist")}"]\n`,
      "utf8",
    );
    const { code, out } = await run(["validate-config"]);
    expect(code).toBe(1);
    expect(out).toContain("dangling-reference");
  });

  test("--fix drops a typo'd key and keeps comments, leaving a valid config", async () => {
    const original = `# my config
[connectors.github]
repo = ["a/b"]   # typo for repos
repos = ["owner/repo"]
`;
    writeFileSync(configPath, original, "utf8");
    const { code, out } = await run(["validate-config", "--fix"]);
    expect(code).toBe(0);
    expect(out).toContain("applied 1 repair");
    expect(out).toContain("config is now valid");
    const after = readFileSync(configPath, "utf8");
    expect(after).toContain("# my config"); // comment preserved
    expect(after).toContain('repos = ["owner/repo"]');
    expect(after).not.toContain("repo = "); // typo removed
  });

  test("--fix drops a dangling local root but keeps the valid one", async () => {
    const good = join(dir, "good-root");
    mkdirSync(good);
    const bad = join(dir, "missing-root");
    const original = `[connectors.local]
roots = [
  "${bad}",
  "${good}",
]
`;
    writeFileSync(configPath, original, "utf8");
    const { code, out } = await run(["validate-config", "--fix"]);
    expect(code).toBe(0);
    expect(out).toContain("applied 1 repair");
    const after = readFileSync(configPath, "utf8");
    expect(after).toContain(good);
    expect(after).not.toContain(bad);
  });

  test("--fix leaves non-fixable findings and exits 1", async () => {
    writeFileSync(
      configPath,
      `[embedding]\nbackend = "nope"\n[connectors.github]\nrepo = ["a/b"]\n`,
      "utf8",
    );
    const { code, out } = await run(["validate-config", "--fix"]);
    expect(code).toBe(1);
    // The typo is fixed, but the bad enum is not auto-fixable and remains.
    expect(out).toContain("applied 1 repair");
    expect(out).toContain("finding(s) remain");
    expect(out).toContain("embedding.backend");
    expect(existsSync(configPath)).toBe(true);
  });

  // Readiness layer (Issue #294): DB vec0-dim guard + advisory warnings.
  describe("readiness checks (#294)", () => {
    test("ERRORs when [embedding].dim disagrees with the existing DB's vec0 dim", async () => {
      // Create a DB whose vec0 table is 1536-dim, then point config at it with
      // dim = 1024 — the classic silent-recall-break footgun.
      const dbPath = join(dir, "mismatch.db");
      openDatabase({ path: dbPath, embeddingDim: 1536 }).close();
      writeFileSync(
        configPath,
        `[storage]\ndbPath = "${dbPath}"\n[embedding]\nbackend = "disabled"\ndim = 1024\n`,
        "utf8",
      );
      const { code, out } = await run(["validate-config"]);
      expect(code).toBe(1);
      expect(out).toContain("embedding.dim");
      expect(out).toContain("1536");
      expect(out).toContain("invalid-value");
    });

    test("passes when [embedding].dim matches the existing DB's vec0 dim", async () => {
      const dbPath = join(dir, "match.db");
      openDatabase({ path: dbPath, embeddingDim: 1024 }).close();
      writeFileSync(
        configPath,
        `[storage]\ndbPath = "${dbPath}"\n[embedding]\nbackend = "disabled"\ndim = 1024\n`,
        "utf8",
      );
      const { code, out } = await run(["validate-config"]);
      expect(code).toBe(0);
      expect(out).toContain("config is valid");
    });

    test("no dim finding when the DB does not exist yet (fresh install)", async () => {
      writeFileSync(
        configPath,
        `[storage]\ndbPath = "${join(dir, "absent.db")}"\n[embedding]\nbackend = "disabled"\ndim = 768\n`,
        "utf8",
      );
      const { code, out } = await run(["validate-config"]);
      expect(code).toBe(0);
      expect(out).toContain("config is valid");
    });

    test("surfaces an [llm] backend as a readiness advisory (does not gate exit)", async () => {
      // A well-formed config whose [llm].backend is set: accepted but unused at
      // runtime (host-delegated, ADR-0006). Advisory only — exit stays 0.
      writeFileSync(
        configPath,
        `[storage]\ndbPath = "${join(dir, "advisory.db")}"\n[embedding]\nbackend = "disabled"\n[llm]\nbackend = "anthropic"\n`,
        "utf8",
      );
      const { code, out } = await run(["validate-config"]);
      expect(code).toBe(0);
      expect(out).toContain("config is valid");
      expect(out).toContain("readiness advisories");
      expect(out).toContain("llm.backend");
    });
  });
});
