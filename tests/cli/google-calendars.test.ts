/**
 * `suasor google calendars` discovery CLI wiring + the DISCOVERY_SPECS probe
 * (ADR-0030). No network: the no-credential path short-circuits before any probe;
 * the google probe is exercised directly with an injected secret resolver + a
 * fake transport via the spec's lazy leaf import.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCli } from "../../src/cli/index.ts";
import { DISCOVERY_SPECS } from "../../src/connectors/discovery-specs.ts";
import {
  type GoogleCalendarsTransport,
  listCalendars,
  renderConfigBlock,
} from "../../src/connectors/google/calendars.ts";

const SECRET_ENVS = [
  "SUASOR_CONNECTOR_GOOGLE_REFRESHTOKEN",
  "SUASOR_CONNECTOR_GOOGLE_CLIENTSECRET",
  "SUASOR_CONNECTOR_GOOGLE_WORK_REFRESHTOKEN",
];

/** Run the CLI capturing stdout/stderr (google secret envs cleared). */
async function run(
  args: string[],
  configDir?: string,
): Promise<{ code: number; out: string; err: string }> {
  const saved = SECRET_ENVS.map((k) => [k, process.env[k]] as const);
  for (const k of SECRET_ENVS) delete process.env[k];
  const savedConfigDir = process.env.SUASOR_CONFIG_DIR;
  if (configDir !== undefined) process.env.SUASOR_CONFIG_DIR = configDir;
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
    if (configDir !== undefined) {
      if (savedConfigDir === undefined) delete process.env.SUASOR_CONFIG_DIR;
      else process.env.SUASOR_CONFIG_DIR = savedConfigDir;
    }
  }
}

describe("suasor google calendars — CLI wiring (no network)", () => {
  test("registers `google calendars` in --help", async () => {
    const { code, out } = await run(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("google calendars");
  });

  test("google calendars without a refresh token exits 1 with onboarding guidance", async () => {
    const { code, err } = await run(["google", "calendars"]);
    expect(code).toBe(1);
    expect(err).toContain("no google refreshToken configured");
    expect(err).toContain("google auth set");
  });
});

// ADR-0050 / #441: with several accounts configured, "which account's namespace
// am I enumerating" has to be answered explicitly — pasting the personal
// account's calendar ids under the work account is a silent mis-config.
describe("suasor google calendars — per-account targeting (ADR-0050)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "suasor-gcal-acct-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function withAccounts(args: string[]): Promise<{ code: number; err: string }> {
    await Bun.write(
      join(dir, "config.toml"),
      [
        "[storage]",
        `dbPath = "${dir}/x.db"`,
        "[connectors.google]",
        'clientId = "shared"',
        "[connectors.google.accounts.personal]",
        "[connectors.google.accounts.work]",
        "",
      ].join("\n"),
    );
    const { code, err } = await run(args, dir);
    return { code, err };
  }

  test("refuses to guess which account to enumerate", async () => {
    const { code, err } = await withAccounts(["google", "calendars"]);
    expect(code).toBe(1);
    expect(err).toContain("pass --account");
    expect(err).toContain("personal, work");
  });

  test("--account resolves that account's credential (absent here → its own error)", async () => {
    const { code, err } = await withAccounts(["google", "calendars", "--account", "work"]);
    expect(code).toBe(1);
    expect(err).toContain("no google refreshToken configured");
  });

  test("an unknown account name is refused, listing the configured ones", async () => {
    const { code, err } = await withAccounts(["google", "calendars", "--account", "wrok"]);
    expect(code).toBe(1);
    expect(err).toContain("no account 'wrok'");
  });

  test("--account is refused on a connector with no per-account config", async () => {
    const { code, err } = await run(["github", "repos", "--account", "work"]);
    expect(code).toBe(1);
    expect(err).toContain("no per-account configuration");
    // Same refusal as `onboard` and `auth`, naming the connectors that do accept
    // `--account` (#544), derived from the manifests rather than listed here.
    expect(err).toContain("box");
    expect(err).toContain("google");
  });
});

describe("DISCOVERY_SPECS.google.discover probe (injected secret + transport)", () => {
  test("throws the no-token error when the refresh token is absent", async () => {
    await expect(
      DISCOVERY_SPECS.google?.discover({ secret: async () => null, config: { clientId: "c" } }),
    ).rejects.toThrow(/no google refreshToken configured/);
  });

  test("requires clientId in config", async () => {
    await expect(
      DISCOVERY_SPECS.google?.discover({ secret: async () => "rt", config: {} }),
    ).rejects.toThrow(/clientId is required/);
  });

  test("normalizes items + config block from the leaf (filter applied)", async () => {
    // Exercise the leaf the spec delegates to, with a fake transport, to confirm
    // the item/attrs/config-block shape the CLI renders.
    const transport: GoogleCalendarsTransport = async (req) => {
      if (req.method === "POST") return { status: 200, body: { access_token: "at" } };
      return {
        status: 200,
        body: {
          items: [
            { id: "primary", summary: "Me", timeZone: "Asia/Tokyo", primary: true },
            { id: "work@acme.com", summary: "Acme Work", timeZone: "UTC" },
            { id: "noise@x.com", summary: "Noise" },
          ],
        },
      };
    };
    const result = await listCalendars(
      { clientId: "c", refreshToken: "rt" },
      { transport, filter: "acme" },
    );
    expect(result.calendars.map((c) => c.id)).toEqual(["work@acme.com"]);
    const block = renderConfigBlock(result).join("\n");
    expect(block).toContain("calendarIds = [");
    expect(block).toContain('  "work@acme.com",  # Acme Work, UTC');
    expect(block).not.toContain("noise@x.com");
  });
});
