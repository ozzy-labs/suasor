/**
 * `suasor connectors list` CLI wiring (introspection verb, ADR-0007 /
 * docs/design/cli.md). Exercises the registered command end-to-end against a
 * temp config dir. Token presence is driven through the env override
 * (`SUASOR_CONNECTOR_<NAME>_<SECRET>`) so the test never touches the OS keychain;
 * connectors with no override (and no keychain entry) report "missing".
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCli } from "../../src/cli/index.ts";

let dir: string;

/** Connector secret env overrides cleared per test for isolation. */
const SECRET_ENVS = [
  "SUASOR_CONNECTOR_GITHUB_TOKEN",
  "SUASOR_CONNECTOR_SLACK_TOKEN",
  "SUASOR_CONNECTOR_MS_GRAPH_CLIENTSECRET",
  "SUASOR_CONNECTOR_GOOGLE_REFRESHTOKEN",
  "SUASOR_CONNECTOR_BOX_TOKEN",
];

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "suasor-cli-connectors-"));
  for (const name of SECRET_ENVS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const name of SECRET_ENVS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
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

async function writeConfig(toml: string): Promise<void> {
  await Bun.write(join(dir, "config.toml"), toml);
}

type Status = { name: string; enabled: boolean; tokenConfigured: boolean | null };

describe("suasor connectors list", () => {
  test("--help lists the connectors list command", async () => {
    const { code, out } = await run(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("connectors list");
  });

  test("lists every registered connector", async () => {
    await run(["init"]);
    const { code, out } = await run(["connectors", "list", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as Status[];
    expect(parsed.map((s) => s.name).sort()).toEqual(
      ["box", "github", "google", "local", "ms-graph", "slack", "web"].sort(),
    );
  });

  test("reports each enabled/token state (enabled+token, enabled+no-token, disabled)", async () => {
    await run(["init"]);
    // github: enabled slice + token via env override → enabled, configured.
    // slack: enabled slice, no token → enabled, missing.
    // box: explicitly disabled → disabled, missing.
    await writeConfig(
      [
        "[connectors.github]",
        "repos = []",
        "",
        "[connectors.slack]",
        "",
        "[connectors.box]",
        "enabled = false",
      ].join("\n"),
    );
    process.env.SUASOR_CONNECTOR_GITHUB_TOKEN = "ghp_test";

    const { code, out } = await run(["connectors", "list", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as Status[];
    const byName = Object.fromEntries(parsed.map((s) => [s.name, s]));

    expect(byName.github).toEqual({ name: "github", enabled: true, tokenConfigured: true });
    expect(byName.slack).toEqual({ name: "slack", enabled: true, tokenConfigured: false });
    expect(byName.box).toEqual({ name: "box", enabled: false, tokenConfigured: false });
  });

  test("web (no-auth connector) reports tokenConfigured: null", async () => {
    await run(["init"]);
    const { code, out } = await run(["connectors", "list", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as Status[];
    const web = parsed.find((s) => s.name === "web");
    expect(web?.tokenConfigured).toBeNull();
  });

  test("a connector with no config slice is disabled by default", async () => {
    await run(["init"]);
    const { code, out } = await run(["connectors", "list", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as Status[];
    // init writes no [connectors.*] slices → all disabled.
    expect(parsed.every((s) => s.enabled === false)).toBe(true);
  });

  test("human-readable output shows status + count line", async () => {
    await run(["init"]);
    await writeConfig("[connectors.github]\nrepos = []\n");
    const { code, out } = await run(["connectors", "list"]);
    expect(code).toBe(0);
    expect(out).toContain("github");
    expect(out).toContain("token:");
    expect(out).toMatch(/\d+ connector\(s\), \d+ enabled\./);
  });
});
