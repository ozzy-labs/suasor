/**
 * `suasor github repos` discovery CLI wiring + the DISCOVERY_SPECS probe (ADR-0030).
 * No network: the no-credential path short-circuits before any probe; the
 * github probe is exercised directly with an injected secret resolver + a fake
 * transport via the spec's lazy leaf import.
 */
import { describe, expect, test } from "bun:test";
import { buildCli } from "../../src/cli/index.ts";
import { DISCOVERY_SPECS, discoveryConnectorNames } from "../../src/connectors/discovery-specs.ts";
import {
  type GithubReposTransport,
  listRepos,
  renderConfigBlock,
} from "../../src/connectors/github/repos.ts";

const SECRET_ENVS = ["SUASOR_CONNECTOR_GITHUB_TOKEN"];

/** Run the CLI capturing stdout/stderr (github secret env cleared). */
async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const saved = SECRET_ENVS.map((k) => [k, process.env[k]] as const);
  for (const k of SECRET_ENVS) delete process.env[k];
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
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("DISCOVERY_SPECS table (SSOT)", () => {
  test("exposes exactly github repos for now", () => {
    expect(discoveryConnectorNames()).toEqual(["github"]);
    expect(DISCOVERY_SPECS.github?.verb).toBe("repos");
    expect(DISCOVERY_SPECS.slack).toBeUndefined(); // Slack keeps its own conversations
  });
});

describe("suasor github repos — CLI wiring (no network)", () => {
  test("registers `github repos` in --help", async () => {
    const { code, out } = await run(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("github repos");
  });

  test("github repos without a token exits 1 with onboarding guidance", async () => {
    const { code, err } = await run(["github", "repos"]);
    expect(code).toBe(1);
    expect(err).toContain("no github token configured");
    expect(err).toContain("github auth set");
  });
});

describe("DISCOVERY_SPECS.github.discover probe (injected secret + transport)", () => {
  test("throws the no-token error when the secret is absent", async () => {
    await expect(
      DISCOVERY_SPECS.github?.discover({ secret: async () => null, config: {} }),
    ).rejects.toThrow(/no github token configured/);
  });

  test("normalizes items + config block from the leaf (filter applied)", async () => {
    // Exercise the leaf the spec delegates to, with a fake transport, to confirm
    // the item/attrs/config-block shape the CLI renders.
    const transport: GithubReposTransport = async () => ({
      status: 200,
      linkHeader: null,
      body: [
        { full_name: "acme/widget", visibility: "private", archived: true },
        { full_name: "acme/gadget", visibility: "public" },
        { full_name: "octocat/spoon", visibility: "public" },
      ],
    });
    const result = await listRepos("ghp_x", { transport, filter: "acme" });
    expect(result.repos.map((r) => r.fullName)).toEqual(["acme/gadget", "acme/widget"]);
    const block = renderConfigBlock(result).join("\n");
    expect(block).toContain('"acme/widget",  # private, archived');
    expect(block).toContain('"acme/gadget",  # public');
    expect(block).not.toContain("octocat/spoon");
  });
});
