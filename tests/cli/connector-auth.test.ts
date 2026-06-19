/**
 * `<connector> auth set` / `<connector> auth test` CLI wiring + arg validation
 * (Issue #85). No network: the no-credential paths short-circuit before any
 * probe, and `auth set` with empty input fails fast. The `AUTH_SPECS` `test`
 * wiring (secret resolution + config reads + probe) is exercised directly with
 * an injected secret resolver, avoiding the real keychain/network.
 */
import { describe, expect, test } from "bun:test";
import { buildCli } from "../../src/cli/index.ts";
import { AUTH_SPECS, authConnectorNames } from "../../src/connectors/auth-specs.ts";

/** Connector secret env vars cleared so resolution can't pick up host state. */
const SECRET_ENVS = [
  "SUASOR_CONNECTOR_GITHUB_TOKEN",
  "SUASOR_CONNECTOR_MS_GRAPH_CLIENTSECRET",
  "SUASOR_CONNECTOR_GOOGLE_REFRESHTOKEN",
  "SUASOR_CONNECTOR_BOX_TOKEN",
];

/** Run the CLI capturing stdout/stderr (connector secret envs cleared). */
async function run(
  args: string[],
  stdin: AsyncIterable<Buffer | string> = (async function* () {})(),
): Promise<{ code: number; out: string; err: string }> {
  const saved = SECRET_ENVS.map((k) => [k, process.env[k]] as const);
  for (const k of SECRET_ENVS) delete process.env[k];
  let out = "";
  let err = "";
  const cli = buildCli();
  try {
    const code = await cli.run(args, {
      stdin: stdin as unknown as NodeJS.ReadStream,
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
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("suasor <connector> auth — wiring + arg validation (no network)", () => {
  test("all four connectors register auth set + auth test in --help", async () => {
    const { code, out } = await run(["--help"]);
    expect(code).toBe(0);
    for (const name of ["github", "ms-graph", "google", "box"]) {
      expect(out).toContain(`${name} auth set`);
      expect(out).toContain(`${name} auth test`);
    }
  });

  test("auth set with no value (empty stdin) exits 1 with guidance", async () => {
    const { code, err } = await run(["github", "auth", "set"]);
    expect(code).toBe(1);
    expect(err).toContain("no Personal Access Token provided");
  });

  test("ms-graph auth set surfaces its secret label on empty input", async () => {
    const { code, err } = await run(["ms-graph", "auth", "set"]);
    expect(code).toBe(1);
    expect(err).toContain("no app client secret provided");
  });

  test("github auth test without a token exits 1 with onboarding guidance", async () => {
    const { code, err } = await run(["github", "auth", "test"]);
    expect(code).toBe(1);
    expect(err).toContain("no github token configured");
    expect(err).toContain("github auth set");
  });

  test("box auth test without a token exits 1 with onboarding guidance", async () => {
    const { code, err } = await run(["box", "auth", "test"]);
    expect(code).toBe(1);
    expect(err).toContain("no box token configured");
  });
});

describe("AUTH_SPECS table (SSOT)", () => {
  test("covers exactly github / ms-graph / google / box (Slack keeps its own)", () => {
    expect(authConnectorNames()).toEqual(["box", "github", "google", "ms-graph"]);
    expect(AUTH_SPECS.slack).toBeUndefined();
  });

  test("each spec stores the secret name the connector reads at sync time", () => {
    expect(AUTH_SPECS.github?.secretName).toBe("token");
    expect(AUTH_SPECS["ms-graph"]?.secretName).toBe("clientSecret");
    expect(AUTH_SPECS.google?.secretName).toBe("refreshToken");
    expect(AUTH_SPECS.box?.secretName).toBe("token");
  });
});

describe("AUTH_SPECS.test probe wiring (injected secret resolver)", () => {
  const noSecret = async () => null;

  test("github test throws the no-token error when the secret is absent", async () => {
    await expect(AUTH_SPECS.github?.test({ secret: noSecret, config: {} })).rejects.toThrow(
      /no github token configured/,
    );
  });

  test("ms-graph test requires tenantId + clientId in config", async () => {
    await expect(
      AUTH_SPECS["ms-graph"]?.test({
        secret: async (n) => (n === "clientSecret" ? "cs" : null),
        config: {},
      }),
    ).rejects.toThrow(/tenantId and clientId are required/);
  });

  test("google test requires clientId in config", async () => {
    await expect(
      AUTH_SPECS.google?.test({
        secret: async (n) => (n === "refreshToken" ? "rt" : null),
        config: {},
      }),
    ).rejects.toThrow(/clientId is required/);
  });

  test("box test throws the no-token error when the secret is absent", async () => {
    await expect(AUTH_SPECS.box?.test({ secret: noSecret, config: {} })).rejects.toThrow(
      /no box token configured/,
    );
  });
});
