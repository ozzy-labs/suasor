/**
 * Standalone-binary command gating end-to-end through the CLI (Issue #167).
 *
 * The build type is injected via SUASOR_FORCE_BINARY (the test seam in
 * src/cli/build-target.ts) since the suite runs under `bun test`, never as a
 * compiled binary. For each binary-unsupported command we assert: binary build →
 * exit 1 + the dedicated human-readable error (no opaque module/keyring failure);
 * normal build → the command proceeds past the gate (its own validation runs).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FORCE_BINARY_ENV } from "../../src/cli/build-target.ts";
import { buildCli } from "../../src/cli/index.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "suasor-cli-binary-gate-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Run the CLI with the build type forced via {@link FORCE_BINARY_ENV}. */
async function run(
  args: string[],
  opts: { binary: boolean } = { binary: false },
): Promise<{ code: number; out: string; err: string }> {
  const savedCfg = process.env.SUASOR_CONFIG_DIR;
  const savedForce = process.env[FORCE_BINARY_ENV];
  process.env.SUASOR_CONFIG_DIR = dir;
  if (opts.binary) process.env[FORCE_BINARY_ENV] = "1";
  else delete process.env[FORCE_BINARY_ENV];
  let out = "";
  let err = "";
  const cli = buildCli();
  try {
    const code = await cli.run(args, {
      stdin: (async function* () {})() as unknown as NodeJS.ReadStream,
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
    if (savedCfg === undefined) delete process.env.SUASOR_CONFIG_DIR;
    else process.env.SUASOR_CONFIG_DIR = savedCfg;
    if (savedForce === undefined) delete process.env[FORCE_BINARY_ENV];
    else process.env[FORCE_BINARY_ENV] = savedForce;
  }
}

const UNSUPPORTED = "not available in the standalone binary";

describe("skills commands — binary gate", () => {
  for (const args of [
    ["skills", "install"],
    ["skills", "list"],
    ["skills", "search", "brief"],
    ["skills", "info", "research"],
  ]) {
    test(`${args.join(" ")}: binary build → exit 1 + dedicated error`, async () => {
      const { code, err } = await run(args, { binary: true });
      expect(code).toBe(1);
      expect(err).toContain(UNSUPPORTED);
      expect(err).toContain("install.md#binary-scope");
      expect(err).not.toContain("Cannot find module");
    });
  }

  test("skills list: normal build runs (no binary error)", async () => {
    const { err } = await run(["skills", "list"], { binary: false });
    expect(err).not.toContain(UNSUPPORTED);
  });
});

describe("<connector> sync — binary gate", () => {
  for (const name of ["slack", "ms-graph", "google", "box", "web"]) {
    test(`${name} sync: binary build → exit 1 + dedicated error`, async () => {
      const { code, err } = await run([name, "sync"], { binary: true });
      expect(code).toBe(1);
      expect(err).toContain(UNSUPPORTED);
      expect(err).toContain(`'${name} sync'`);
      expect(err).not.toContain("Cannot find module");
    });
  }

  test("github sync: bundled connector is NOT gated in the binary", async () => {
    // No config → reaches the connector load / config error, not the binary gate.
    const { err } = await run(["github", "sync"], { binary: true });
    expect(err).not.toContain(UNSUPPORTED);
  });
});

describe("<connector> auth — binary gate", () => {
  for (const name of ["github", "ms-graph", "google", "box"]) {
    test(`${name} auth set: binary build → exit 1 + env-override hint`, async () => {
      const { code, err } = await run([name, "auth", "set", "--token", "x"], { binary: true });
      expect(code).toBe(1);
      expect(err).toContain(UNSUPPORTED);
      expect(err).toContain("hint:");
      expect(err).toContain(`SUASOR_CONNECTOR_${name.toUpperCase().replace(/-/g, "_")}_`);
    });
  }

  for (const name of ["ms-graph", "google", "box"]) {
    test(`${name} auth test: binary build → exit 1 + dedicated error`, async () => {
      const { code, err } = await run([name, "auth", "test"], { binary: true });
      expect(code).toBe(1);
      expect(err).toContain(UNSUPPORTED);
    });
  }

  test("github auth test: bundled SDK is NOT gated in the binary", async () => {
    // github auth test reaches its own no-credential error, not the binary gate.
    const { err } = await run(["github", "auth", "test"], { binary: true });
    expect(err).not.toContain(UNSUPPORTED);
  });
});

describe("suasor sync (bulk) — binary skips external connectors", () => {
  test("enabled external connector is skipped with a warning in the binary", async () => {
    await Bun.write(
      join(dir, "config.toml"),
      ["[connectors.slack]", "enabled = true", "", "[connectors.github]", "repos = []"].join("\n"),
    );
    const { err, out } = await run(["sync"], { binary: true });
    expect(err).toContain("skipping slack");
    expect(err).toContain("not available in the standalone binary");
    expect(err).toContain("install.md#binary-scope");
    // github (bundled) still ran.
    expect(out).toContain("github");
  });
});
