/**
 * `suasor onboard` wizard flow (ADR-0029, Issue #160). No network / no keychain:
 * tests drive the non-interactive path (`--skip-auth --skip-sync`) against a temp
 * SUASOR_CONFIG_DIR, asserting the config slice append (the structural fix), the
 * non-TTY guard (--connector required), arg validation, and the --json summary.
 * Auth/sync orchestration reuse the same units exercised elsewhere, so these
 * tests focus on the wizard's own glue and its only new side effect.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCli } from "../../src/cli/index.ts";

/** Run the CLI capturing stdout/stderr, with a non-TTY stdin by default. */
async function run(
  args: string[],
  opts: { configDir?: string; stdin?: AsyncIterable<Buffer | string> } = {},
): Promise<{ code: number; out: string; err: string }> {
  const prevDir = process.env.SUASOR_CONFIG_DIR;
  if (opts.configDir) process.env.SUASOR_CONFIG_DIR = opts.configDir;
  let out = "";
  let err = "";
  const cli = buildCli();
  const stdin = opts.stdin ?? (async function* () {})();
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
    if (prevDir === undefined) delete process.env.SUASOR_CONFIG_DIR;
    else process.env.SUASOR_CONFIG_DIR = prevDir;
  }
}

describe("suasor onboard — wiring + validation", () => {
  test("registers in --help under Setup", async () => {
    const { code, out } = await run(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("onboard");
  });

  test("non-TTY stdin without --connector exits 1 with guidance", async () => {
    const { code, err } = await run(["onboard"]);
    expect(code).toBe(1);
    expect(err).toContain("--connector is required");
  });

  test("an unknown connector exits 1 and lists the known set", async () => {
    const { code, err } = await run([
      "onboard",
      "--connector",
      "nope",
      "--skip-auth",
      "--skip-sync",
    ]);
    expect(code).toBe(1);
    expect(err).toContain("unknown connector(s): nope");
    expect(err).toContain("github");
  });

  test("an empty --connector value exits 1", async () => {
    const { code, err } = await run(["onboard", "--connector", "", "--skip-auth", "--skip-sync"]);
    expect(code).toBe(1);
    expect(err).toContain("--connector was empty");
  });

  test("multiple connectors over a non-TTY stdin without --skip-auth exits 1", async () => {
    // One pipe cannot carry N tokens unambiguously; the wizard rejects it up
    // front rather than draining stdin on the first connector and failing rest.
    const { code, err } = await run(["onboard", "--connector", "github,box", "--skip-sync"]);
    expect(code).toBe(1);
    expect(err).toContain("cannot read multiple connector tokens");
    expect(err).toContain("--skip-auth");
  });
});

describe("suasor onboard — config slice append (the structural fix)", () => {
  test("appends [connectors.github] enabled = true to a fresh config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "suasor-onboard-"));
    try {
      const { code, out } = await run(
        ["onboard", "--connector", "github", "--skip-auth", "--skip-sync"],
        { configDir: dir },
      );
      expect(code).toBe(0);
      expect(out).toContain("appended [connectors.github]");
      const toml = await Bun.file(join(dir, "config.toml")).text();
      expect(toml).toContain("[connectors.github]");
      expect(toml).toContain("enabled = true");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("is idempotent: a second run reports the slice already present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "suasor-onboard-"));
    try {
      await run(["onboard", "--connector", "slack", "--skip-auth", "--skip-sync"], {
        configDir: dir,
      });
      const { out } = await run(["onboard", "--connector", "slack", "--skip-auth", "--skip-sync"], {
        configDir: dir,
      });
      expect(out).toContain("already in config.toml");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not rewrite a connector the user set enabled = false", async () => {
    const dir = mkdtempSync(join(tmpdir(), "suasor-onboard-"));
    try {
      const configPath = join(dir, "config.toml");
      await Bun.write(configPath, "[connectors.box]\nenabled = false\n");
      const { code } = await run(["onboard", "--connector", "box", "--skip-auth", "--skip-sync"], {
        configDir: dir,
      });
      expect(code).toBe(0);
      const toml = await Bun.file(configPath).text();
      expect(toml).toContain("enabled = false");
      expect(toml).not.toContain("enabled = true");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("suasor onboard — --json summary", () => {
  test("emits a per-connector step report with the scheduler kind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "suasor-onboard-"));
    try {
      const { code, out } = await run(
        ["onboard", "--connector", "github", "--skip-auth", "--skip-sync", "--json"],
        { configDir: dir },
      );
      expect(code).toBe(0);
      const report = JSON.parse(out) as {
        connectors: { connector: string; configAppended: boolean }[];
        synced: boolean;
        scheduler: string;
      };
      expect(report.connectors[0]?.connector).toBe("github");
      expect(report.connectors[0]?.configAppended).toBe(true);
      expect(report.synced).toBe(false);
      expect(["cron", "launchd", "systemd"]).toContain(report.scheduler);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("multiple connectors each get a report entry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "suasor-onboard-"));
    try {
      const { out } = await run(
        ["onboard", "--connector", "github,slack", "--skip-auth", "--skip-sync", "--json"],
        { configDir: dir },
      );
      const report = JSON.parse(out) as { connectors: { connector: string }[] };
      expect(report.connectors.map((c) => c.connector)).toEqual(["github", "slack"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("suasor onboard — discovery → config block (ADR-0030, Issue #195)", () => {
  const realFetch = globalThis.fetch;
  const realToken = process.env.SUASOR_CONNECTOR_GITHUB_TOKEN;

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realToken === undefined) delete process.env.SUASOR_CONNECTOR_GITHUB_TOKEN;
    else process.env.SUASOR_CONNECTOR_GITHUB_TOKEN = realToken;
  });

  /** Stub `globalThis.fetch` with a single `GET /user/repos` page (no Link header). */
  function stubGithubRepos(repos: { full_name: string; visibility?: string }[]): void {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(repos), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
  }

  test("a discovery-capable connector with a token appends the discovered ids", async () => {
    const dir = mkdtempSync(join(tmpdir(), "suasor-onboard-"));
    process.env.SUASOR_CONNECTOR_GITHUB_TOKEN = "ghp_test_token";
    stubGithubRepos([
      { full_name: "acme/api", visibility: "private" },
      { full_name: "acme/web", visibility: "public" },
    ]);
    try {
      // --skip-auth (no keychain write) but the env override supplies the token,
      // so discovery still runs and the rendered block lands in config.toml.
      const { code, out } = await run(
        ["onboard", "--connector", "github", "--skip-auth", "--skip-sync"],
        { configDir: dir },
      );
      expect(code).toBe(0);
      expect(out).toContain("discovered 2 item(s)");
      const toml = await Bun.file(join(dir, "config.toml")).text();
      expect(toml).toContain("[connectors.github]");
      expect(toml).toContain("enabled = true");
      expect(toml).toContain('"acme/api"');
      expect(toml).toContain('"acme/web"');
      // The discovery block carries the ids array (not just a commented placeholder).
      expect(toml).toContain("repos = [");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--json reports configSource=discovery with the discovered count", async () => {
    const dir = mkdtempSync(join(tmpdir(), "suasor-onboard-"));
    process.env.SUASOR_CONNECTOR_GITHUB_TOKEN = "ghp_test_token";
    stubGithubRepos([{ full_name: "acme/api", visibility: "private" }]);
    try {
      const { code, out } = await run(
        ["onboard", "--connector", "github", "--skip-auth", "--skip-sync", "--json"],
        { configDir: dir },
      );
      expect(code).toBe(0);
      const report = JSON.parse(out) as {
        connectors: { configSource: string; discovered?: number; configAppended: boolean }[];
      };
      expect(report.connectors[0]?.configSource).toBe("discovery");
      expect(report.connectors[0]?.discovered).toBe(1);
      expect(report.connectors[0]?.configAppended).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a discovery-capable connector with no token falls back to the placeholder template", async () => {
    const dir = mkdtempSync(join(tmpdir(), "suasor-onboard-"));
    // No env override token, --skip-auth → discovery throws "no github token" and
    // the wizard writes the minimal placeholder slice instead.
    delete process.env.SUASOR_CONNECTOR_GITHUB_TOKEN;
    try {
      const { code, out, err } = await run(
        ["onboard", "--connector", "github", "--skip-auth", "--skip-sync", "--json"],
        { configDir: dir },
      );
      expect(code).toBe(0);
      const report = JSON.parse(out) as { connectors: { configSource: string }[] };
      expect(report.connectors[0]?.configSource).toBe("template");
      // The fallback reason is surfaced on stderr (kept out of --json stdout).
      expect(err).toContain("discovery skipped");
      const toml = await Bun.file(join(dir, "config.toml")).text();
      expect(toml).toContain("[connectors.github]");
      // The commented placeholder, not a populated repos array.
      expect(toml).toContain("# repos =");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a non-discovery connector appends the placeholder template (configSource=template)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "suasor-onboard-"));
    try {
      // `web` has no discovery verb → always the placeholder template path.
      const { code, out } = await run(
        ["onboard", "--connector", "web", "--skip-auth", "--skip-sync", "--json"],
        { configDir: dir },
      );
      expect(code).toBe(0);
      const report = JSON.parse(out) as { connectors: { configSource: string }[] };
      expect(report.connectors[0]?.configSource).toBe("template");
      const toml = await Bun.file(join(dir, "config.toml")).text();
      expect(toml).toContain("[connectors.web]");
      expect(toml).toContain("# urls =");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an existing slice is left untouched even for a discovery-capable connector", async () => {
    const dir = mkdtempSync(join(tmpdir(), "suasor-onboard-"));
    process.env.SUASOR_CONNECTOR_GITHUB_TOKEN = "ghp_test_token";
    // Discovery must not run / overwrite when the slice already exists.
    stubGithubRepos([{ full_name: "acme/api" }]);
    try {
      const configPath = join(dir, "config.toml");
      await Bun.write(configPath, "[connectors.github]\nenabled = false\n");
      const { code, out } = await run(
        ["onboard", "--connector", "github", "--skip-auth", "--skip-sync", "--json"],
        { configDir: dir },
      );
      expect(code).toBe(0);
      const report = JSON.parse(out) as {
        connectors: { configSource: string; configAppended: boolean }[];
      };
      expect(report.connectors[0]?.configAppended).toBe(false);
      expect(report.connectors[0]?.configSource).toBe("skipped");
      const toml = await Bun.file(configPath).text();
      expect(toml).toContain("enabled = false");
      expect(toml).not.toContain('"acme/api"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
