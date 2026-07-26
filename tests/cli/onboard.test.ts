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
import {
  KEYCHAIN_SERVICE,
  type KeychainBackend,
  keychainAccount,
} from "../../src/connectors/secrets.ts";

/** Run the CLI capturing stdout/stderr, with a non-TTY stdin by default. */
async function run(
  args: string[],
  opts: {
    configDir?: string;
    stdin?: AsyncIterable<Buffer | string>;
    /** In-memory keychain injected via context so token storage skips the OS keyring. */
    keychain?: KeychainBackend;
  } = {},
): Promise<{ code: number; out: string; err: string }> {
  const prevDir = process.env.SUASOR_CONFIG_DIR;
  if (opts.configDir) process.env.SUASOR_CONFIG_DIR = opts.configDir;
  let out = "";
  let err = "";
  const cli = buildCli();
  const stdin = opts.stdin ?? (async function* () {})();
  // Built as a variable (not an inline literal) so the extra `keychain` field is
  // accepted structurally — clipanion merges custom context fields onto
  // `this.context`, which the commands read to override the keychain in tests.
  const context = {
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
    ...(opts.keychain ? { keychain: opts.keychain } : {}),
  };
  try {
    const code = await cli.run(args, context);
    return { code, out, err };
  } finally {
    if (prevDir === undefined) delete process.env.SUASOR_CONFIG_DIR;
    else process.env.SUASOR_CONFIG_DIR = prevDir;
  }
}

/** An in-memory keychain backend that records `set` writes (never touches the OS keyring). */
function memoryKeychain(): KeychainBackend & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: (service, account) => store.get(`${service} ${account}`) ?? null,
    set: (service, account, value) => {
      store.set(`${service} ${account}`, value);
    },
  };
}

/**
 * A TTY-flagged stdin (so the wizard treats entry as interactive) whose async
 * iterator yields the given token lines and then **hangs** rather than closing —
 * modeling an open terminal the wizard must not wait on for EOF. It exposes no
 * `setRawMode`, so `readSecretLine` uses its line-buffered path (the raw-mode
 * keystroke handling is unit-tested separately via `editRawSecret`).
 */
function ttyTokenStdin(...lines: string[]): { isTTY: true } & AsyncIterable<string> {
  let i = 0;
  const iterator: AsyncIterator<string> = {
    next() {
      if (i < lines.length) return Promise.resolve({ value: lines[i++] as string, done: false });
      return new Promise<IteratorResult<string>>(() => {}); // hang: never closes
    },
    return: () => Promise.resolve({ value: undefined, done: true }),
  };
  return { isTTY: true, [Symbol.asyncIterator]: () => iterator };
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

/** A TTY-flagged stdin that yields the given line(s) then EOF. */
function ttyStdin(...lines: string[]): AsyncIterable<Buffer | string> & { isTTY: boolean } {
  return {
    isTTY: true,
    async *[Symbol.asyncIterator]() {
      for (const line of lines) yield `${line}\n`;
    },
  };
}

describe("suasor onboard — interactive connector selection (ADR-0029 §2, Issue #293)", () => {
  test("a TTY stdin with no --connector prompts and resolves the name selection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "suasor-onboard-"));
    try {
      // Select by name (the menu's number order is the registry order, which is
      // not part of this contract); --skip-auth/--skip-sync so the prompt line
      // is the only stdin we consume.
      const { code, out } = await run(["onboard", "--skip-auth", "--skip-sync"], {
        configDir: dir,
        stdin: ttyStdin("github"),
      });
      expect(code).toBe(0);
      expect(out).toContain("Select connector(s)");
      expect(out).toContain("appended [connectors.github]");
      const toml = await Bun.file(join(dir, "config.toml")).text();
      expect(toml).toContain("[connectors.github]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an empty interactive selection exits 1", async () => {
    const { code, err } = await run(["onboard", "--skip-auth", "--skip-sync"], {
      stdin: ttyStdin(""),
    });
    expect(code).toBe(1);
    expect(err).toContain("no connector selected");
  });
});

describe("suasor onboard — scheduler invocation note (Issue #293)", () => {
  test("the human-readable output carries an invocation note for the cron/scheduler template", async () => {
    const dir = mkdtempSync(join(tmpdir(), "suasor-onboard-"));
    try {
      const { code, out } = await run(
        ["onboard", "--connector", "web", "--skip-auth", "--skip-sync"],
        { configDir: dir },
      );
      expect(code).toBe(0);
      // The bun test runner launches from a .ts entry → from-source channel, so
      // the note warns that `suasor` is not on PATH. (In any channel a Note: line
      // about the invocation is always present.)
      expect(out).toContain("Note:");
      expect(out.toLowerCase()).toContain("path");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

/**
 * Stub `globalThis.fetch` for the slack bridge probes (Issue #384 Phase 2/3): the
 * one `auth.test` round-trip (`testToken`) and the `users.conversations` listing
 * leaf. No real network / SDK: both slack `fetch`-based leaves go through
 * `slackFetch` → `globalThis.fetch`. The bridge sweeps public then private, so the
 * public channels are returned for the `public_channel` type and nothing for the
 * rest (a compact fixture). `conversationsError` makes the listing throw so the
 * discovery-fallback path can be exercised.
 */
function stubSlackApi(
  opts: {
    authError?: string;
    scopes?: string;
    teamId?: string;
    publicChannels?: { id: string; name?: string; is_member?: boolean }[];
    conversationsError?: string;
  } = {},
): void {
  globalThis.fetch = (async (input: string | URL) => {
    const url = input.toString();
    if (url.includes("auth.test")) {
      const body = opts.authError
        ? { ok: false, error: opts.authError }
        : {
            ok: true,
            team: "Acme",
            team_id: opts.teamId ?? "T0ACME",
            user: "suasor-bot",
            user_id: "U0BOT",
            bot_id: "B0BOT",
          };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-oauth-scopes": opts.scopes ?? "channels:history,groups:history,users:read",
        },
      });
    }
    if (url.includes("users.conversations")) {
      if (opts.conversationsError) {
        return new Response(JSON.stringify({ ok: false, error: opts.conversationsError }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const type = new URL(url).searchParams.get("types");
      const channels = type === "public_channel" ? (opts.publicChannels ?? []) : [];
      return new Response(JSON.stringify({ ok: true, channels }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch in slack bridge test: ${url}`);
  }) as unknown as typeof fetch;
}

describe("suasor onboard — slack bridge (Issue #384 Phase 2/3)", () => {
  const realFetch = globalThis.fetch;
  const realToken = process.env.SUASOR_CONNECTOR_SLACK_TOKENS;

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realToken === undefined) delete process.env.SUASOR_CONNECTOR_SLACK_TOKENS;
    else process.env.SUASOR_CONNECTOR_SLACK_TOKENS = realToken;
  });

  test("stores the pasted token under the pool `tokens` secret (ADR-0042)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "suasor-onboard-"));
    // The env override keeps the probe off the real keychain; the pasted token is
    // the one asserted to land in the (in-memory) keychain under `slack:token`.
    process.env.SUASOR_CONNECTOR_SLACK_TOKENS = "xoxb-env";
    stubSlackApi();
    const keychain = memoryKeychain();
    try {
      const { code } = await run(["onboard", "--connector", "slack", "--skip-sync"], {
        configDir: dir,
        stdin: ttyStdin("xoxb-pasted"),
        keychain,
      });
      expect(code).toBe(0);
      expect(keychain.store.get(`${KEYCHAIN_SERVICE} ${keychainAccount("slack", "tokens")}`)).toBe(
        "xoxb-pasted",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("appends a [connectors.slack] block with only the joined channels from the probe", async () => {
    const dir = mkdtempSync(join(tmpdir(), "suasor-onboard-"));
    process.env.SUASOR_CONNECTOR_SLACK_TOKENS = "xoxb-env";
    // C0JOIN is a member channel (goes into config); C0NOPE is not joined (excluded
    // — it would ingest nothing until the bot joins, ADR-0011).
    stubSlackApi({
      publicChannels: [
        { id: "C0JOIN", name: "general", is_member: true },
        { id: "C0NOPE", name: "random", is_member: false },
      ],
    });
    try {
      const { code, out } = await run(
        ["onboard", "--connector", "slack", "--skip-auth", "--skip-sync", "--json"],
        { configDir: dir },
      );
      expect(code).toBe(0);
      const report = JSON.parse(out) as {
        connectors: { configSource: string; discovered?: number }[];
      };
      expect(report.connectors[0]?.configSource).toBe("discovery");
      expect(report.connectors[0]?.discovered).toBe(1);
      const toml = await Bun.file(join(dir, "config.toml")).text();
      expect(toml).toContain("[connectors.slack]");
      expect(toml).toContain("enabled = true");
      // The slice goes through the same surgical editor `slack follow` uses
      // (#472): the id is the entry, the name rides as a comment label.
      expect(toml).toContain('"C0JOIN",  # #general');
      // The unjoined channel is not auto-configured.
      expect(toml).not.toContain("C0NOPE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("falls back to the placeholder slice + reason when the conversations probe fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "suasor-onboard-"));
    process.env.SUASOR_CONNECTOR_SLACK_TOKENS = "xoxb-env";
    // auth.test succeeds (so a team id resolves) but the listing leaf throws.
    stubSlackApi({ conversationsError: "internal_error" });
    try {
      const { code, out, err } = await run(
        ["onboard", "--connector", "slack", "--skip-auth", "--skip-sync", "--json"],
        { configDir: dir },
      );
      expect(code).toBe(0);
      const report = JSON.parse(out) as { connectors: { configSource: string }[] };
      expect(report.connectors[0]?.configSource).toBe("template");
      // The fallback reason is surfaced on stderr (kept out of --json stdout).
      expect(err).toContain("discovery skipped");
      const toml = await Bun.file(join(dir, "config.toml")).text();
      expect(toml).toContain("[connectors.slack]");
      // The commented placeholder, not a populated channels array.
      expect(toml).toContain("# channels =");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("leaves an existing [connectors.slack] (enabled = false) untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "suasor-onboard-"));
    process.env.SUASOR_CONNECTOR_SLACK_TOKENS = "xoxb-env";
    stubSlackApi({ publicChannels: [{ id: "C0JOIN", name: "general", is_member: true }] });
    try {
      const configPath = join(dir, "config.toml");
      await Bun.write(configPath, "[connectors.slack]\nenabled = false\n");
      const { code, out } = await run(
        ["onboard", "--connector", "slack", "--skip-auth", "--skip-sync", "--json"],
        { configDir: dir },
      );
      expect(code).toBe(0);
      const report = JSON.parse(out) as { connectors: { configSource: string }[] };
      expect(report.connectors[0]?.configSource).toBe("skipped");
      const toml = await Bun.file(configPath).text();
      expect(toml).toContain("enabled = false");
      expect(toml).not.toContain("enabled = true");
      // Discovery must not run / write channels when the slice already exists.
      expect(toml).not.toContain("C0JOIN");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an interactive decline writes the placeholder and points at follow --suggest (#472)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "suasor-onboard-"));
    process.env.SUASOR_CONNECTOR_SLACK_TOKENS = "xoxb-env";
    stubSlackApi({
      publicChannels: [{ id: "C0JOIN", name: "general", is_member: true }],
    });
    try {
      const { code, out, err } = await run(
        ["onboard", "--connector", "slack", "--skip-auth", "--skip-sync"],
        { configDir: dir, stdin: ttyStdin("n") },
      );
      expect(code).toBe(0);
      // The suggestion list was shown, the decline skipped the channels…
      expect(out).toContain("1 joined channel(s) not yet configured:");
      expect(err).toContain("slack follow --suggest");
      const toml = await Bun.file(join(dir, "config.toml")).text();
      // …and the placeholder slice (no channels) was written instead.
      expect(toml).toContain("[connectors.slack]");
      expect(toml).not.toContain("C0JOIN");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a legacy multi-workspace config falls back to the migration checklist (ADR-0042)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "suasor-onboard-"));
    // No env override / fetch stub: a multi-workspace config bails before the token
    // read + probe, so nothing touches stdin or the network.
    try {
      const configPath = join(dir, "config.toml");
      const original =
        "[connectors.slack]\nenabled = true\n\n" +
        '[connectors.slack.workspaces.acme]\nteam = "T0ACME"\nchannels = ["C0AAA"]\n';
      await Bun.write(configPath, original);
      const { code, out } = await run(["onboard", "--connector", "slack", "--skip-sync"], {
        configDir: dir,
      });
      expect(code).toBe(0);
      // The wizard points at the ADR-0042 migration and re-surfaces the checklist.
      expect(out).toContain("legacy multi-workspace config detected (acme)");
      expect(out).toContain("setup is not complete yet");
      expect(out).toContain("Setup needs manual steps");
      // Config is left byte-for-byte untouched (no flat bridge write).
      expect(await Bun.file(configPath).text()).toBe(original);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a pre-existing invalid config does not hard-fail the slack workspace detection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "suasor-onboard-"));
    // An unrelated connector slice with an unknown key fails loadConfig's strict
    // per-slice validation. The multi-workspace detection loads the config, so it
    // must degrade to "no aliases → flat bridge" rather than letting the throw
    // hard-fail `onboard --connector slack` (Issue #384 review). --skip-auth keeps
    // it off the keychain/network; --skip-sync avoids the later loadConfig at sync.
    await Bun.write(join(dir, "config.toml"), "[connectors.github]\nbogus_key = true\n");
    try {
      const { code, out } = await run(
        ["onboard", "--connector", "slack", "--skip-auth", "--skip-sync", "--json"],
        { configDir: dir },
      );
      expect(code).toBe(0);
      const report = JSON.parse(out) as { connectors: { connector: string }[] };
      expect(report.connectors[0]?.connector).toBe("slack");
      // The flat bridge still ran and appended a slack slice next to the (untouched)
      // invalid github slice.
      const toml = await Bun.file(join(dir, "config.toml")).text();
      expect(toml).toContain("[connectors.slack]");
      expect(toml).toContain("bogus_key = true");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--json marks slack authFlow=connector-specific and generic connectors as generic", async () => {
    const dir = mkdtempSync(join(tmpdir(), "suasor-onboard-"));
    // Hermetic: the env override keeps the slack probe off the real OS keychain,
    // and the fetch stub keeps its auth.test / conversations round-trips off the
    // network (a flat, unconfigured slack config runs the bridge under --skip-auth).
    process.env.SUASOR_CONNECTOR_SLACK_TOKENS = "xoxb-env";
    stubSlackApi();
    try {
      const { code, out } = await run(
        ["onboard", "--connector", "github,slack", "--skip-auth", "--skip-sync", "--json"],
        { configDir: dir },
      );
      expect(code).toBe(0);
      const report = JSON.parse(out) as {
        connectors: { connector: string; authFlow: string; configAppended: boolean }[];
      };
      const byName = new Map(report.connectors.map((c) => [c.connector, c]));
      expect(byName.get("slack")?.authFlow).toBe("connector-specific");
      expect(byName.get("github")?.authFlow).toBe("generic");
      // Existing fields are untouched (the field is purely additive).
      expect(byName.get("github")?.configAppended).toBe(true);
      // --json suppresses the human-readable bridge output entirely.
      expect(out).not.toContain("token stored in the OS keychain");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("suasor onboard — interactive token entry (Issue #383)", () => {
  const realFetch = globalThis.fetch;
  const secretEnvs = ["SUASOR_CONNECTOR_GITHUB_TOKEN", "SUASOR_CONNECTOR_BOX_TOKEN"];
  const saved = secretEnvs.map((k) => [k, process.env[k]] as const);

  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  /**
   * The `auth test` / discovery probes resolve the secret from the env override
   * first, so setting these keeps those probes off the real OS keychain; the
   * network round-trip itself is disabled by stubbing `fetch` to reject.
   */
  function disableNetworkAndKeychainReads(): void {
    for (const k of secretEnvs) process.env[k] = "env-token";
    globalThis.fetch = (async () => {
      throw new Error("network disabled in test");
    }) as unknown as typeof fetch;
  }

  test("completes on a TTY whose stdin stays open after the token line (no EOF hang)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "suasor-onboard-"));
    disableNetworkAndKeychainReads();
    const keychain = memoryKeychain();
    try {
      // The stdin yields the token line then never closes — the old read-to-EOF
      // path hung here; the wizard must resolve on Enter and finish.
      const { code } = await run(["onboard", "--connector", "github", "--skip-sync"], {
        configDir: dir,
        stdin: ttyTokenStdin("ghp_interactive\n"),
        keychain,
      });
      // The auth probe rejects (network stubbed) → Issue #388 now surfaces that
      // via exit 1; the token still lands in the keychain (stored before the probe).
      expect(code).toBe(1);
      expect(keychain.store.get(`${KEYCHAIN_SERVICE} ${keychainAccount("github", "token")}`)).toBe(
        "ghp_interactive",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("interactive multi-connector: each token line lands in its own keychain account", async () => {
    // Previously the first token drained stdin to EOF, so the second connector
    // aborted with "no token provided". Line-based entry gives each its own line.
    const dir = mkdtempSync(join(tmpdir(), "suasor-onboard-"));
    disableNetworkAndKeychainReads();
    const keychain = memoryKeychain();
    try {
      const { code } = await run(["onboard", "--connector", "github,box", "--skip-sync"], {
        configDir: dir,
        stdin: ttyTokenStdin("ghp_first\n", "box_second\n"),
        keychain,
      });
      // Both auth probes reject (network stubbed) → exit 1 (Issue #388); the point
      // of this test is that each token line lands in its own keychain account.
      expect(code).toBe(1);
      expect(keychain.store.get(`${KEYCHAIN_SERVICE} ${keychainAccount("github", "token")}`)).toBe(
        "ghp_first",
      );
      expect(keychain.store.get(`${KEYCHAIN_SERVICE} ${keychainAccount("box", "token")}`)).toBe(
        "box_second",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("suasor onboard — final recap + exit code (Issue #388 item 1)", () => {
  const realFetch = globalThis.fetch;
  const realToken = process.env.SUASOR_CONNECTOR_GITHUB_TOKEN;

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realToken === undefined) delete process.env.SUASOR_CONNECTOR_GITHUB_TOKEN;
    else process.env.SUASOR_CONNECTOR_GITHUB_TOKEN = realToken;
  });

  test("an auth-test failure prints a FAILED recap line and exits 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "suasor-onboard-"));
    // env override supplies the secret (keeps the probe off the real keychain);
    // fetch rejects so the github auth probe fails.
    process.env.SUASOR_CONNECTOR_GITHUB_TOKEN = "env-token";
    globalThis.fetch = (async () => {
      throw new Error("network disabled in test");
    }) as unknown as typeof fetch;
    const keychain = memoryKeychain();
    try {
      const { code, out } = await run(["onboard", "--connector", "github", "--skip-sync"], {
        configDir: dir,
        stdin: ttyTokenStdin("ghp_token\n"),
        keychain,
      });
      expect(code).toBe(1);
      // The recap closes the screen with the failure + its recovery command.
      expect(out).toContain("Setup recap:");
      expect(out).toContain("auth test FAILED");
      expect(out).toContain("suasor github auth test");
      expect(out).toContain("Setup finished with errors");
      // The recap lands after the scheduler / MCP blocks (it is the final block).
      // Assert the MCP block is actually present first, so the position check does
      // not pass vacuously against a -1 (missing) index.
      expect(out).toContain("mcpServers");
      expect(out.indexOf("Setup recap:")).toBeGreaterThan(out.indexOf("mcpServers"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a fully skipped run prints an ok recap and exits 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "suasor-onboard-"));
    try {
      const { code, out } = await run(
        ["onboard", "--connector", "github", "--skip-auth", "--skip-sync"],
        { configDir: dir },
      );
      expect(code).toBe(0);
      expect(out).toContain("Setup recap:");
      expect(out).not.toContain("FAILED");
      expect(out).toContain("Setup complete.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("suasor onboard — channel-aware MCP snippet (Issue #388 item 2)", () => {
  test("prints a channel-aware MCP registration block + substitution note", async () => {
    const dir = mkdtempSync(join(tmpdir(), "suasor-onboard-"));
    try {
      const { code, out } = await run(
        ["onboard", "--connector", "web", "--skip-auth", "--skip-sync"],
        { configDir: dir },
      );
      expect(code).toBe(0);
      const mcpIdx = out.indexOf('"mcpServers"');
      expect(mcpIdx).toBeGreaterThanOrEqual(0);
      // The registration command is one of the known channel invocations, not a
      // hard-coded "suasor" — the test runner launches from a .ts entry, so the
      // wizard substitutes the from-source `bun` invocation here.
      const block = out.slice(mcpIdx);
      expect(block).toMatch(/"command": "(suasor|bun|bunx)"/);
      // An MCP-specific note is printed directly *after* the snippet (Issue #388
      // item 2). Asserting on the post-snippet slice (not the whole output) so the
      // scheduler's own note earlier on cannot stand in for it.
      expect(block).toContain("Note:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * `suasor onboard --account <name>` — the second-account path (ADR-0050, Issue
 * #538). No keychain / no network unless a test stubs `fetch`: the credential is
 * supplied through the account's own env override (the same name `auth set
 * --account` writes to), so the wizard's own glue is what is under test.
 */
describe("suasor onboard — --account (multi-account, ADR-0050 / Issue #538)", () => {
  const realFetch = globalThis.fetch;
  const ACCOUNT_ENVS = ["SUASOR_CONNECTOR_BOX_TOKEN", "SUASOR_CONNECTOR_BOX_WORK_TOKEN"];
  const saved = new Map<string, string | undefined>();

  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const key of ACCOUNT_ENVS) {
      const prev = saved.get(key);
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
    saved.clear();
  });

  /** Set an env override for the duration of one test (restored in afterEach). */
  function setEnv(key: string, value: string): void {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    process.env[key] = value;
  }

  /** One `GET /2.0/folders/0/items` page with the given subfolders (no marker). */
  function stubBoxFolders(folders: { id: string; name: string }[]): void {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ entries: folders.map((f) => ({ type: "folder", ...f })) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
  }

  test("refuses a connector that declares no per-account configuration", async () => {
    // github's ingest scope is `owner/repo` — globally unique, so the manifest
    // declares multiAccount: false and --account has nothing to name.
    const { code, err } = await run([
      "onboard",
      "--connector",
      "github",
      "--account",
      "work",
      "--skip-auth",
      "--skip-sync",
    ]);
    expect(code).toBe(1);
    expect(err).toContain("--account does not apply to github");
    // The supported set is derived from the manifests, not listed in the CLI.
    expect(err).toContain("box");
    expect(err).toContain("google");
    expect(err).toContain("ms-graph");
  });

  test("refuses an account name outside the account charset", async () => {
    const { code, err } = await run([
      "onboard",
      "--connector",
      "box",
      "--account",
      "work.mail",
      "--skip-auth",
      "--skip-sync",
    ]);
    expect(code).toBe(1);
    expect(err).toContain("invalid account name 'work.mail'");
  });

  test("refuses a name whose env override would collide with a configured account", async () => {
    const dir = mkdtempSync(join(tmpdir(), "suasor-onboard-"));
    try {
      // `work-a` and `work_a` are different accounts that normalize to the same
      // SUASOR_CONNECTOR_BOX_WORK_A_TOKEN. Writing the table first and finding out
      // at the next load would leave a config.toml the wizard itself broke.
      await Bun.write(
        join(dir, "config.toml"),
        "[connectors.box]\nenabled = true\n\n[connectors.box.accounts.work-a]\n",
      );
      const { code, err } = await run(
        ["onboard", "--connector", "box", "--account", "work_a", "--skip-auth", "--skip-sync"],
        { configDir: dir },
      );
      expect(code).toBe(1);
      expect(err).toContain("both map to the env override segment 'WORK_A'");
      const toml = await Bun.file(join(dir, "config.toml")).text();
      expect(toml).not.toContain("accounts.work_a");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a fresh config gets the connector slice plus the account table", async () => {
    const dir = mkdtempSync(join(tmpdir(), "suasor-onboard-"));
    try {
      const { code, out } = await run(
        ["onboard", "--connector", "box", "--account", "work", "--skip-auth", "--skip-sync"],
        { configDir: dir },
      );
      expect(code).toBe(0);
      const toml = await Bun.file(join(dir, "config.toml")).text();
      // `enabled` lives on the connector, so the account table alone would enable
      // nothing — the flat slice is written first.
      expect(toml).toContain("[connectors.box]");
      expect(toml).toContain("enabled = true");
      expect(toml).toContain("[connectors.box.accounts.work]");
      expect(out).toContain("appended [connectors.box.accounts.work]");
      // Nothing was demoted: there was no account here before this run.
      expect(toml).not.toContain("accounts.default");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps the already-syncing account when its credential proves it existed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "suasor-onboard-"));
    // A credential for the *unnamed* default account is the evidence that
    // account was really ingesting (ADR-0050 決定 5's warn level).
    setEnv("SUASOR_CONNECTOR_BOX_TOKEN", "default-token");
    try {
      await Bun.write(
        join(dir, "config.toml"),
        '[connectors.box]\nenabled = true\nfolders = ["0"]\n',
      );
      const { code, out } = await run(
        [
          "onboard",
          "--connector",
          "box",
          "--account",
          "work",
          "--skip-auth",
          "--skip-sync",
          "--json",
        ],
        { configDir: dir },
      );
      expect(code).toBe(0);
      const report = JSON.parse(out) as {
        connectors: { account?: string; defaultAccount?: string }[];
      };
      expect(report.connectors[0]?.account).toBe("work");
      expect(report.connectors[0]?.defaultAccount).toBe("preserved");
      const toml = await Bun.file(join(dir, "config.toml")).text();
      expect(toml).toContain("[connectors.box.accounts.default]");
      expect(toml).toContain("[connectors.box.accounts.work]");
      // The pre-existing flat keys are untouched (they are now the inherited
      // defaults, and `accounts.default` is what keeps ingesting them).
      expect(toml).toContain('folders = ["0"]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("states the rule but writes nothing when no default credential is stored", async () => {
    const dir = mkdtempSync(join(tmpdir(), "suasor-onboard-"));
    try {
      await Bun.write(join(dir, "config.toml"), "[connectors.box]\nenabled = true\n");
      const { code, out, err } = await run(
        [
          "onboard",
          "--connector",
          "box",
          "--account",
          "work",
          "--skip-auth",
          "--skip-sync",
          "--json",
        ],
        { configDir: dir },
      );
      expect(code).toBe(0);
      const report = JSON.parse(out) as { connectors: { defaultAccount?: string }[] };
      expect(report.connectors[0]?.defaultAccount).toBe("unknown");
      // "was ingesting" and "never was" are indistinguishable here, so the wizard
      // says so instead of guessing — and does not write an account that would
      // then be a credential-less warned skip on every sync.
      expect(err).toContain("cannot be told from here");
      expect(err).toContain("[connectors.box.accounts.default]");
      // The discovery re-run advice has to name the account: with two accounts
      // configured, `suasor box folders` alone is refused as ambiguous.
      expect(err).toContain("suasor box folders --account work");
      const toml = await Bun.file(join(dir, "config.toml")).text();
      expect(toml).not.toContain("accounts.default");
      expect(toml).toContain("[connectors.box.accounts.work]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("adding a third account does not re-litigate the demotion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "suasor-onboard-"));
    setEnv("SUASOR_CONNECTOR_BOX_TOKEN", "default-token");
    try {
      // An `accounts` table already exists, so this run is not what demotes the
      // flat keys — doctor owns the standing report, the wizard only reports the
      // demotion it causes itself.
      await Bun.write(
        join(dir, "config.toml"),
        "[connectors.box]\nenabled = true\n\n[connectors.box.accounts.personal]\n",
      );
      const { code, out, err } = await run(
        [
          "onboard",
          "--connector",
          "box",
          "--account",
          "work",
          "--skip-auth",
          "--skip-sync",
          "--json",
        ],
        { configDir: dir },
      );
      expect(code).toBe(0);
      const report = JSON.parse(out) as { connectors: { defaultAccount?: string }[] };
      expect(report.connectors[0]?.defaultAccount).toBe("not-applicable");
      expect(err).not.toContain("cannot be told from here");
      const toml = await Bun.file(join(dir, "config.toml")).text();
      expect(toml).not.toContain("accounts.default");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--account default spells out the first account without demoting anything", async () => {
    const dir = mkdtempSync(join(tmpdir(), "suasor-onboard-"));
    try {
      await Bun.write(join(dir, "config.toml"), "[connectors.box]\nenabled = true\n");
      const { code, out } = await run(
        [
          "onboard",
          "--connector",
          "box",
          "--account",
          "default",
          "--skip-auth",
          "--skip-sync",
          "--json",
        ],
        { configDir: dir },
      );
      expect(code).toBe(0);
      const report = JSON.parse(out) as { connectors: { defaultAccount?: string }[] };
      expect(report.connectors[0]?.defaultAccount).toBe("not-applicable");
      const toml = await Bun.file(join(dir, "config.toml")).text();
      expect(toml).toContain("[connectors.box.accounts.default]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("is idempotent: a second run leaves the account table untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "suasor-onboard-"));
    try {
      const args = [
        "onboard",
        "--connector",
        "box",
        "--account",
        "work",
        "--skip-auth",
        "--skip-sync",
      ];
      await run(args, { configDir: dir });
      const first = await Bun.file(join(dir, "config.toml")).text();
      const { code, out } = await run(args, { configDir: dir });
      expect(code).toBe(0);
      expect(out).toContain("[connectors.box.accounts.work] already in config.toml");
      expect(await Bun.file(join(dir, "config.toml")).text()).toBe(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("recognises an account declared in a spelling the header scan cannot see", async () => {
    const dir = mkdtempSync(join(tmpdir(), "suasor-onboard-"));
    try {
      // `[connectors.box.accounts."work"]` is valid TOML declaring account
      // `work`, but it is not the literal header the line scan matches.
      // Appending on top of it would leave two tables for one account, and
      // whichever the parser then resolves is a scope the operator never chose.
      const configPath = join(dir, "config.toml");
      const base =
        '[connectors.box]\nenabled = true\n\n[connectors.box.accounts."work"]\nfolders = ["77"]\n';
      await Bun.write(configPath, base);
      const { code, out } = await run(
        ["onboard", "--connector", "box", "--account", "work", "--skip-auth", "--skip-sync"],
        { configDir: dir },
      );
      expect(code).toBe(0);
      expect(out).toContain("[connectors.box.accounts.work] already in config.toml");
      expect(await Bun.file(configPath).text()).toBe(base);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stores the token under the account's own keychain name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "suasor-onboard-"));
    const keychain = memoryKeychain();
    // Offline: every probe this run would make fails at the transport, so the
    // test never leaves the machine (the assertion is where the token landed).
    globalThis.fetch = (async () => {
      throw new Error("offline test");
    }) as unknown as typeof fetch;
    try {
      const { code, out } = await run(
        ["onboard", "--connector", "box", "--account", "work", "--skip-sync"],
        { configDir: dir, stdin: ttyTokenStdin("work-token\n"), keychain },
      );
      // The auth probe cannot reach Box, so the run reports a failed `auth test`
      // (exit 1) — expected, and not what this test is about.
      expect(code).toBe(1);
      expect(out).toContain("for account 'work'");
      expect(
        keychain.store.get(`${KEYCHAIN_SERVICE} ${keychainAccount("box", "work:token")}`),
      ).toBe("work-token");
      // Never under the unnamed default's name — that is the mix-up ADR-0050
      // exists to prevent (the wrong mailbox syncs and nothing says so).
      expect(keychain.store.get(`${KEYCHAIN_SERVICE} ${keychainAccount("box", "token")}`)).toBe(
        undefined,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("discovery runs as the new account and its ids land in the account table", async () => {
    const dir = mkdtempSync(join(tmpdir(), "suasor-onboard-"));
    // Only the *work* account has a credential; the ids it enumerates are its
    // own, which is the whole point — a folder id from another account addresses
    // nothing here.
    setEnv("SUASOR_CONNECTOR_BOX_WORK_TOKEN", "work-token");
    stubBoxFolders([{ id: "9911", name: "Work Docs" }]);
    try {
      const { code, out } = await run(
        ["onboard", "--connector", "box", "--account", "work", "--skip-auth", "--skip-sync"],
        { configDir: dir },
      );
      expect(code).toBe(0);
      expect(out).toContain("discovered 1 item(s)");
      const toml = await Bun.file(join(dir, "config.toml")).text();
      expect(toml).toContain("[connectors.box.accounts.work]");
      expect(toml).toContain('"9911"');
      expect(toml).toContain("folders = [");
      // `enabled` stays a connector-level switch: exactly one occurrence, in the
      // flat slice, never copied into the account table where nothing reads it.
      expect(toml.match(/enabled = true/g)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the recap names the account", async () => {
    const dir = mkdtempSync(join(tmpdir(), "suasor-onboard-"));
    try {
      const { code, out } = await run(
        ["onboard", "--connector", "box", "--account", "work", "--skip-auth", "--skip-sync"],
        { configDir: dir },
      );
      expect(code).toBe(0);
      expect(out).toContain("box (account 'work')");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
