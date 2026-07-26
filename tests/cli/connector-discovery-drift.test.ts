/**
 * `suasor <connector> <verb> --new` CLI wiring (ADR-0049 — ADR-0039 Layer 1
 * generalized onto DISCOVERY_SPECS, Issue #478).
 *
 * No network: the flag-shape decisions all happen before any credential is
 * resolved, and the diff itself is unit-tested in
 * `tests/connectors/discovery-drift.test.ts`. What is pinned here is that the
 * flag is registered on the connectors that can diff, that it is *refused with
 * the reason* on the one that cannot, and that the refusal names the alternative.
 */
import { describe, expect, test } from "bun:test";
import { buildCli } from "../../src/cli/index.ts";

const SECRET_ENVS = [
  "SUASOR_CONNECTOR_GITHUB_TOKEN",
  "SUASOR_CONNECTOR_GOOGLE_REFRESHTOKEN",
  "SUASOR_CONNECTOR_NOTION_TOKEN",
];

/** Run the CLI capturing stdout/stderr (discovery secret envs cleared). */
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

describe("discovery --new — registered where the scope is a set of ids", () => {
  test("github repos --help documents --new against the real config key", async () => {
    const { code, out } = await run(["github", "repos", "--help"]);
    expect(code).toBe(0);
    expect(out).toContain("--new");
    expect(out).toContain("repos");
  });

  test("github repos --new is accepted (it fails only on the missing credential)", async () => {
    const { code, err } = await run(["github", "repos", "--new"]);
    expect(code).toBe(1);
    // The flag itself is not the complaint — the absent token is.
    expect(err).toContain("no github token configured");
    expect(err).not.toContain("not available");
  });

  test("notion databases --new is accepted", async () => {
    const { code, err } = await run(["notion", "databases", "--new"]);
    expect(code).toBe(1);
    expect(err).toContain("no notion token configured");
  });
});

describe("discovery --new — google joined once its scope became a set (ADR-0051)", () => {
  test("google calendars --new is accepted (it fails only on the missing credential)", async () => {
    const { code, err } = await run(["google", "calendars", "--new"]);
    expect(code).toBe(1);
    // The flag itself is no longer the complaint — the absent credential is.
    expect(err).not.toContain("not available");
    expect(err).toContain("no google refreshToken configured");
  });

  test("google calendars without --new still works as a plain enumeration verb", async () => {
    const { code, err } = await run(["google", "calendars"]);
    expect(code).toBe(1);
    expect(err).toContain("no google refreshToken configured");
  });
});
