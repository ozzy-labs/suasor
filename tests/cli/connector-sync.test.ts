/**
 * `suasor <connector> sync` CLI wiring (FR-ING-4, docs/design/cli.md).
 *
 * Exercises the registered `github sync` command end-to-end against a real
 * on-disk store. To stay network-free, the config sets `repos = []`, so the
 * GitHub connector yields no records (and never builds an Octokit client) while
 * the full CLI → config → registry → sync-service path still runs.
 *
 * Credential ordering (#404, generalizing #385): the GitHub connector now
 * resolves its token *before* the empty-scope no-op, so an empty `repos` with no
 * token exits 1 (missing credential), just like slack. The "0 observed" no-op
 * path therefore requires a token to be present — the empty-scope tests below
 * inject one via the `SUASOR_CONNECTOR_GITHUB_TOKEN` env override (no keychain,
 * no network: the token is never used because the empty scope returns first).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCli } from "../../src/cli/index.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "suasor-cli-sync-"));
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

async function writeConfig(toml: string): Promise<void> {
  await Bun.write(join(dir, "config.toml"), toml);
}

/**
 * Run a CLI invocation with a GitHub token present via the env override (no
 * keychain, no network). Used by the empty-`repos` no-op tests: under the #404
 * credential ordering, "0 observed" requires a token to be resolvable — without
 * one the run correctly exits 1 (see the tokenless test). The token itself is
 * never used because the empty scope returns before any Octokit client is built.
 */
async function runWithGithubToken(
  args: string[],
): Promise<{ code: number; out: string; err: string }> {
  const ENV = "SUASOR_CONNECTOR_GITHUB_TOKEN";
  const prev = process.env[ENV];
  process.env[ENV] = "ghp-test-token";
  try {
    return await run(args);
  } finally {
    if (prev === undefined) delete process.env[ENV];
    else process.env[ENV] = prev;
  }
}

describe("suasor github sync", () => {
  test("--help lists the github sync command", async () => {
    const { code, out } = await run(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("github sync");
  });

  test("runs end-to-end with no repos (no network) and reports counts", async () => {
    await run(["init"]);
    await writeConfig("[connectors.github]\nrepos = []\n");
    // Token present + empty scope → the 0-observed no-op (regression, #404).
    const { code, out } = await runWithGithubToken(["github", "sync"]);
    expect(code).toBe(0);
    expect(out).toContain("0 observed");
  });

  test("--json emits the sync outcome", async () => {
    await run(["init"]);
    await writeConfig("[connectors.github]\nrepos = []\n");
    const { code, out } = await runWithGithubToken(["github", "sync", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as { connector: string; observed: number };
    expect(parsed.connector).toBe("github");
    expect(parsed.observed).toBe(0);
  });

  test("invalid connector config fails fast with exit 1 (load-time slice validation, #162)", async () => {
    await run(["init"]);
    // A malformed `owner/repo` entry is rejected by the github slice schema at
    // load (`loadConfig`), before the connector is built — fail-fast (#162).
    await writeConfig('[connectors.github]\nrepos = ["not-a-repo"]\n');
    const { code, err } = await run(["github", "sync"]);
    expect(code).toBe(1);
    expect(err).toContain("error:");
    expect(err).toContain("connectors.github.repos");
  });

  test("a typo'd connector key fails fast with exit 1 (#162)", async () => {
    await run(["init"]);
    // `repo` for `repos` — the exact silent-no-op typo #162 targets.
    await writeConfig('[connectors.github]\nrepo = ["owner/repo"]\n');
    const { code, err } = await run(["github", "sync"]);
    expect(code).toBe(1);
    expect(err).toContain("error:");
    expect(err).toContain("connectors.github");
  });

  test("warns (stderr, exit 0) when repos empty and notifications=off (#187)", async () => {
    await run(["init"]);
    // Enabled but no ingest target: no repos and notifications off. With a token
    // present the run still succeeds (0 observed) and the pre-sync no-op advisory
    // surfaces the config; the advisory is emitted before sync, independent of the
    // credential check (#404).
    await writeConfig("[connectors.github]\nrepos = []\n");
    const { code, out, err } = await runWithGithubToken(["github", "sync"]);
    expect(code).toBe(0);
    expect(out).toContain("0 observed");
    expect(err).toContain("warning: github:");
    expect(err).toContain("notifications=off");
  });

  test("no token + repos empty + notifications=off exits 1 (#404 credential ordering)", async () => {
    await run(["init"]);
    // The fresh-onboard state: enabled slice, no repos, notifications off, no
    // token. Credential resolution precedes the empty-scope no-op, so the missing
    // token is a loud error (exit 1) rather than a silent 0-observed exit 0 that
    // hides the missing credential — the github analogue of the slack #385 fix.
    const ENV = "SUASOR_CONNECTOR_GITHUB_TOKEN";
    const prev = process.env[ENV];
    delete process.env[ENV];
    try {
      await writeConfig("[connectors.github]\nrepos = []\n");
      const { code, err } = await run(["github", "sync"]);
      expect(code).toBe(1);
      expect(err).toContain("no token configured");
    } finally {
      if (prev === undefined) delete process.env[ENV];
      else process.env[ENV] = prev;
    }
  });

  test("--discover and --no-discover together fail fast with exit 1 (ADR-0039)", async () => {
    await run(["init"]);
    await writeConfig("[connectors.github]\nrepos = []\n");
    const { code, err } = await run(["github", "sync", "--discover", "--no-discover"]);
    expect(code).toBe(1);
    expect(err).toContain(
      "discovery toggle (--discover / --no-discover) may be given at most once",
    );
  });

  test("--discover on a non-discovery connector is a harmless no-op (no regression)", async () => {
    await run(["init"]);
    await writeConfig("[connectors.github]\nrepos = []\n");
    // github has no discovery concept; the override flag is accepted and ignored.
    const { code, out } = await runWithGithubToken(["github", "sync", "--discover"]);
    expect(code).toBe(0);
    expect(out).toContain("0 observed");
  });

  test("--no-discover on a non-discovery connector is a harmless no-op (no regression)", async () => {
    await run(["init"]);
    await writeConfig("[connectors.github]\nrepos = []\n");
    const { code, out } = await runWithGithubToken(["github", "sync", "--no-discover"]);
    expect(code).toBe(0);
    expect(out).toContain("0 observed");
  });

  test("does NOT warn when notifications stream is enabled (#187)", async () => {
    await run(["init"]);
    // repos empty but notifications=all → the per-token notification stream is a
    // valid ingest target, so no no-op warning. (The sync itself then fails on the
    // missing token, but the no-op advisory must not fire — that is what we assert.)
    await writeConfig('[connectors.github]\nrepos = []\nnotifications = "all"\n');
    const { err } = await run(["github", "sync"]);
    expect(err).not.toContain("nothing to ingest");
  });
});

describe("suasor slack sync — tokenless exits 1 (#385 / ADR-0042)", () => {
  const ENV_NAME = "SUASOR_CONNECTOR_SLACK_TOKENS";

  test("no token pool + no channels fails with exit 1 and records the failed run", async () => {
    await run(["init"]);
    const prev = process.env[ENV_NAME];
    delete process.env[ENV_NAME];
    try {
      await writeConfig("[connectors.slack]\nenabled = true\nchannels = []\n");
      const { code, err } = await run(["slack", "sync"]);
      // Credential resolution precedes the channels-empty no-op: the missing
      // pool is an error even though the scope is empty (#385).
      expect(code).toBe(1);
      expect(err).toContain("error: slack sync failed:");
      expect(err).toContain("no token pool configured");
      // The failed run lands in the run history (ADR-0033), so the freshness
      // view no longer shows a misleading `slack: ok` for a tokenless config.
      const status = await run(["sync", "status"]);
      expect(status.code).toBe(0);
      expect(status.out).toContain("slack: error");
    } finally {
      if (prev === undefined) delete process.env[ENV_NAME];
      else process.env[ENV_NAME] = prev;
    }
  });

  test("token present + no channels still succeeds with the no-op advisory (regression)", async () => {
    await run(["init"]);
    const prev = process.env[ENV_NAME];
    // Env override resolves the pool without touching the real keychain.
    process.env[ENV_NAME] = "xoxb-test-token";
    try {
      await writeConfig("[connectors.slack]\nenabled = true\nchannels = []\n");
      const { code, out, err } = await run(["slack", "sync"]);
      expect(code).toBe(0);
      expect(out).toContain("0 observed");
      expect(err).toContain("warning: slack:");
      // The advisory now names the discovery verb as the id source (#385).
      expect(err).toContain("suasor slack conversations");
    } finally {
      if (prev === undefined) delete process.env[ENV_NAME];
      else process.env[ENV_NAME] = prev;
    }
  });
});
