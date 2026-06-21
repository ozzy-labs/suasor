/**
 * `suasor config edit` (Issue #280). Drives the command with an injected editor
 * (no real $EDITOR spawn): the runner mutates config.toml deterministically, so
 * we can assert the save-then-validate gate — a valid edit persists, an invalid
 * one (bad TOML / schema violation) is rolled back and reported.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigEditCommand } from "../../src/cli/commands/config-edit.ts";

let dir: string;
let configPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "suasor-cli-config-edit-"));
  configPath = join(dir, "config.toml");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Run the command with an injected editor that applies `mutate` to the file the
 * editor would have opened. `mutate` receives the current contents and returns
 * the new contents (or undefined to leave it untouched, simulating "no edit").
 */
async function runEdit(
  mutate: (current: string) => string | undefined,
  editorExit = 0,
): Promise<{ code: number; out: string; err: string }> {
  const prev = process.env.SUASOR_CONFIG_DIR;
  process.env.SUASOR_CONFIG_DIR = dir;
  let out = "";
  let err = "";
  const cmd = new ConfigEditCommand();
  cmd.editor = "stub-editor"; // bypass $EDITOR resolution
  cmd.runEditor = async (_command: string, args: string[]) => {
    const file = args[args.length - 1] as string;
    if (editorExit === 0) {
      const current = readFileSync(file, "utf8");
      const next = mutate(current);
      if (next !== undefined) writeFileSync(file, next, "utf8");
    }
    return editorExit;
  };
  cmd.context = {
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
  };
  try {
    const code = await cmd.execute();
    return { code: code ?? 0, out, err };
  } finally {
    if (prev === undefined) delete process.env.SUASOR_CONFIG_DIR;
    else process.env.SUASOR_CONFIG_DIR = prev;
  }
}

describe("suasor config edit", () => {
  test("errors when config.toml does not exist", async () => {
    const { code, err } = await runEdit(() => undefined);
    expect(code).toBe(1);
    expect(err).toContain("no config.toml");
  });

  test("a valid edit is saved and validated", async () => {
    writeFileSync(configPath, '[embedding]\nbackend = "disabled"\n', "utf8");
    const { code, out } = await runEdit(
      (cur) => `${cur}\n[connectors.github]\nrepos = ["owner/repo"]\n`,
    );
    expect(code).toBe(0);
    expect(out).toContain("config saved and validated");
    expect(readFileSync(configPath, "utf8")).toContain("owner/repo");
  });

  test("no-op edit reports no changes", async () => {
    writeFileSync(configPath, '[embedding]\nbackend = "ollama"\n', "utf8");
    const { code, out } = await runEdit((cur) => cur);
    expect(code).toBe(0);
    expect(out).toContain("no changes");
  });

  test("invalid TOML is rolled back", async () => {
    const original = '[embedding]\nbackend = "disabled"\n';
    writeFileSync(configPath, original, "utf8");
    const { code, err } = await runEdit(() => "this is = = not valid toml [[[");
    expect(code).toBe(1);
    expect(err).toContain("invalid");
    expect(err).toContain("reverted");
    // Original is restored verbatim.
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("a schema violation (typo'd connector key) is rolled back", async () => {
    const original = "[connectors.github]\nrepos = []\n";
    writeFileSync(configPath, original, "utf8");
    const { code, err } = await runEdit(() => '[connectors.github]\nrepo = ["a/b"]\n');
    expect(code).toBe(1);
    expect(err).toContain("invalid");
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("a non-zero editor exit aborts without validating", async () => {
    const original = '[embedding]\nbackend = "disabled"\n';
    writeFileSync(configPath, original, "utf8");
    const { code, err } = await runEdit(() => "mutated but editor failed", 1);
    expect(code).toBe(1);
    expect(err).toContain("editor exited with code 1");
    // File untouched because the stub does not write when editorExit != 0.
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });
});
