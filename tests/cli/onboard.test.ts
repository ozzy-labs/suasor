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

describe("suasor onboard — slack connector-specific next steps (Issue #384)", () => {
  test("prints the 4-step slack auth flow instead of the generic hint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "suasor-onboard-"));
    try {
      // slack has no AUTH_SPECS entry, so storeTokenFor returns "no-spec" without
      // reading stdin — a non-TTY empty stdin (the default) is safe here.
      const { code, out } = await run(["onboard", "--connector", "slack", "--skip-sync"], {
        configDir: dir,
      });
      expect(code).toBe(0);
      expect(out).toContain("slack: uses its own auth flow");
      expect(out).toContain("suasor slack auth set");
      expect(out).toContain("suasor slack auth test");
      expect(out).toContain("suasor slack conversations");
      expect(out).toContain("suasor slack sync");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('never leaks the internal "no generic auth verb" phrasing for slack', async () => {
    const dir = mkdtempSync(join(tmpdir(), "suasor-onboard-"));
    try {
      const { code, out } = await run(["onboard", "--connector", "slack", "--skip-sync"], {
        configDir: dir,
      });
      expect(code).toBe(0);
      expect(out).not.toContain("no generic auth verb");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("re-surfaces the slack next steps after the sync summary (ends incomplete)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "suasor-onboard-"));
    try {
      // Pre-write the slice as enabled = false so the first sync short-circuits to
      // "no enabled connectors" (no store open / no network), yet a sync summary
      // line is still printed — the recap must come *after* it.
      await Bun.write(join(dir, "config.toml"), "[connectors.slack]\nenabled = false\n");
      const { code, out } = await run(["onboard", "--connector", "slack"], { configDir: dir });
      expect(code).toBe(0);
      const syncIdx = out.indexOf("sync:");
      expect(syncIdx).toBeGreaterThanOrEqual(0);
      // The final block on screen is the "not complete yet" checklist.
      expect(out).toContain("slack: setup is not complete yet");
      const recapIdx = out.lastIndexOf("slack: setup is not complete yet");
      expect(recapIdx).toBeGreaterThan(syncIdx);
      // The last slack command line lands after the sync summary too.
      expect(out.lastIndexOf("suasor slack sync")).toBeGreaterThan(syncIdx);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--json marks slack authFlow=connector-specific and generic connectors as generic", async () => {
    const dir = mkdtempSync(join(tmpdir(), "suasor-onboard-"));
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
      // Existing fields are untouched (the new field is purely additive).
      expect(byName.get("github")?.configAppended).toBe(true);
      // --json suppresses the human-readable next-steps / recap entirely.
      expect(out).not.toContain("uses its own auth flow");
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
