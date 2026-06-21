/**
 * `suasor config show [--effective] [--json]` CLI wiring (effective config, docs/design/cli.md).
 * Runs end-to-end against a temp config dir. Secret masking and connector
 * credential presence are driven through env overrides
 * (`SUASOR_*` / `SUASOR_CONNECTOR_<NAME>_<SECRET>`) so the test never touches the
 * OS keychain.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCli } from "../../src/cli/index.ts";

let dir: string;

const MANAGED_ENVS = [
  "SUASOR_CONNECTOR_GITHUB_TOKEN",
  "SUASOR_CONNECTOR_SLACK_TOKEN",
  "SUASOR_CONNECTOR_MS_GRAPH_CLIENTSECRET",
  "SUASOR_CONNECTOR_GOOGLE_REFRESHTOKEN",
  "SUASOR_CONNECTOR_BOX_TOKEN",
  "SUASOR_EMBEDDING__BACKEND",
  "SUASOR_EMBEDDING__MODEL",
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "suasor-cli-config-show-"));
  for (const name of MANAGED_ENVS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const name of MANAGED_ENVS) {
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

type ShowReport = {
  config: Record<string, unknown>;
  credentials: Record<string, { secret: string; configured: boolean }[]>;
};

describe("suasor config show", () => {
  test("--help lists the config show command", async () => {
    const { code, out } = await run(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("config show");
  });

  test("fresh dir: prints defaults (no config.toml), exits 0", async () => {
    const { code, out } = await run(["config", "show"]);
    expect(code).toBe(0);
    expect(out).toContain("effective");
    // Schema defaults are surfaced even without a config.toml.
    expect(out).toContain("embedding.backend = disabled");
    expect(out).toContain("storage.dbPath = ");
  });

  test("--json emits the merged config and a credentials presence map", async () => {
    const { code, out } = await run(["config", "show", "--json"]);
    expect(code).toBe(0);
    const report = JSON.parse(out) as ShowReport;
    expect(report.config.embedding).toMatchObject({ backend: "disabled" });
    // dbPath default is resolved by the loader (not null).
    expect((report.config.storage as { dbPath: string }).dbPath).toContain("suasor.db");
    // Connectors that read secrets appear; web/local (no auth) do not.
    expect(Object.keys(report.credentials)).toContain("github");
    expect(Object.keys(report.credentials)).not.toContain("web");
    expect(Object.keys(report.credentials)).not.toContain("local");
  });

  test("env override wins over the file value (effective precedence)", async () => {
    await writeConfig('[embedding]\nbackend = "disabled"\nmodel = "file-model"\n');
    process.env.SUASOR_EMBEDDING__BACKEND = "ollama";
    const { code, out } = await run(["config", "show", "--json"]);
    expect(code).toBe(0);
    const report = JSON.parse(out) as ShowReport;
    // env override beats the file's "disabled"; the un-overridden file value stays.
    expect(report.config.embedding).toMatchObject({ backend: "ollama", model: "file-model" });
  });

  test("a secret-keyed value pasted into config.toml is masked, never echoed", async () => {
    // Against the contract a token must never be in config.toml — but if one is,
    // config show must mask it (NFR-PRV-4). `[llm]` is a passthrough section, so an
    // arbitrary `apiKey` survives the loader and exercises the masker.
    await writeConfig('[llm]\nbackend = "anthropic"\napiKey = "super-secret-value"\n');
    const json = await run(["config", "show", "--json"]);
    expect(json.code).toBe(0);
    expect(json.out).not.toContain("super-secret-value");
    expect(json.out).toContain("***");
    const human = await run(["config", "show"]);
    expect(human.out).not.toContain("super-secret-value");
    expect(human.out).toContain("llm.apiKey = ***");
  });

  test("connector credential presence reflects the env override, value masked", async () => {
    process.env.SUASOR_CONNECTOR_GITHUB_TOKEN = "ghp_secret_token";
    const { code, out } = await run(["config", "show", "--json"]);
    expect(code).toBe(0);
    const report = JSON.parse(out) as ShowReport;
    const github = report.credentials.github?.find((c) => c.secret === "token");
    expect(github?.configured).toBe(true);
    // Slack has no token set → unconfigured.
    const slack = report.credentials.slack?.find((c) => c.secret === "token");
    expect(slack?.configured).toBe(false);
    // The secret value itself is never disclosed (NFR-PRV-4).
    expect(out).not.toContain("ghp_secret_token");
  });

  test("human report shows credential presence as set/unset, never the value", async () => {
    process.env.SUASOR_CONNECTOR_GITHUB_TOKEN = "ghp_secret_token";
    const { code, out } = await run(["config", "show"]);
    expect(code).toBe(0);
    expect(out).toContain("connectors.github.token = set");
    expect(out).toContain("connectors.slack.token = unset");
    expect(out).not.toContain("ghp_secret_token");
  });

  test("--no-effective is rejected (not a silent no-op)", async () => {
    const { code, out, err } = await run(["config", "show", "--no-effective"]);
    expect(code).toBe(1);
    expect(err).toContain("--no-effective is not supported");
    // It must not silently print the effective report despite the unsupported flag.
    expect(out).not.toContain("config show (effective)");
  });
});
