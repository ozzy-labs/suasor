/**
 * Central `ConfigError` handling (#560).
 *
 * An invalid config.toml — the single most common user mistake — must fail
 * every command with the same clean `error: <message>` + `hint:` pair on
 * stderr (exit 1), never clipanion's internal-error rendering with raw stack
 * frames. The shared base command (`src/cli/base-command.ts`) provides this;
 * the structural test below keeps future commands from bypassing it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Builtins } from "clipanion";
import { SuasorCommand } from "../../src/cli/base-command.ts";
import { buildCli, registeredCommandClasses } from "../../src/cli/index.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "suasor-cli-config-error-"));
  // Invalid on two axes: a type error in [storage] and one in a connector
  // slice. Every config-loading command must fail fast on this.
  writeFileSync(
    join(dir, "config.toml"),
    '[storage]\ndbPath = 123\n\n[connectors.github]\nenabled = "yes"\n',
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Run the CLI capturing stdout/stderr; uses SUASOR_CONFIG_DIR for isolation. */
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

describe("central ConfigError handling", () => {
  // A representative slice of the everyday commands from #560 that used to
  // leak clipanion's stack-trace rendering.
  const cases: [name: string, argv: string[]][] = [
    ["search", ["search", "anything"]],
    ["source list", ["source", "list"]],
    ["brief", ["brief"]],
    ["sync status", ["sync", "status"]],
    ["db migrate", ["db", "migrate"]],
    ["store info", ["store", "info"]],
    ["embeddings status", ["embeddings", "status"]],
  ];

  for (const [name, argv] of cases) {
    test(`${name}: clean error + hint, exit 1, no stack frames`, async () => {
      const { code, out, err } = await run(argv);
      expect(code).toBe(1);
      expect(err).toContain("error: invalid configuration");
      expect(err).toContain("hint: run `suasor validate-config`");
      // Never clipanion's internal-error rendering (stack frames on stdout).
      expect(out).not.toContain("at loadConfig");
      expect(err).not.toContain("at loadConfig");
      expect(out).not.toContain("Config Error");
    });
  }

  test("Zod issue lines are deduplicated", async () => {
    const { err } = await run(["brief"]);
    const line = "storage.dbPath: Invalid input: expected string, received number";
    expect(err).toContain(line);
    expect(err.split(line).length - 1).toBe(1);
  });

  test("every registered command extends SuasorCommand", () => {
    // Structural guard: a future command that extends clipanion's Command
    // directly would silently reintroduce the stack-trace rendering. The
    // clipanion builtins (help/version) never load config and stay exempt.
    const builtins = new Set<unknown>([Builtins.HelpCommand, Builtins.VersionCommand]);
    const offenders = registeredCommandClasses()
      .filter((cls) => !builtins.has(cls) && !(cls.prototype instanceof SuasorCommand))
      .map((cls) => cls.name);
    expect(offenders).toEqual([]);
  });
});
