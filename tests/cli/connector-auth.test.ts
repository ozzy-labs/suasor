/**
 * `<connector> auth set` / `<connector> auth test` CLI wiring + arg validation
 * (Issue #85). No network: the no-credential paths short-circuit before any
 * probe, and `auth set` with empty input fails fast. The `AUTH_SPECS` `test`
 * wiring (secret resolution + config reads + probe) is exercised directly with
 * an injected secret resolver, avoiding the real keychain/network.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCli } from "../../src/cli/index.ts";
import { AUTH_SPECS, authConnectorNames } from "../../src/connectors/auth-specs.ts";
import { connectorSecretNames } from "../../src/connectors/registry.ts";
import {
  KEYCHAIN_SERVICE,
  type KeychainBackend,
  keychainAccount,
} from "../../src/connectors/secrets.ts";

/** Connector secret env vars cleared so resolution can't pick up host state. */
const SECRET_ENVS = [
  "SUASOR_CONNECTOR_GITHUB_TOKEN",
  "SUASOR_CONNECTOR_MS_GRAPH_CLIENTSECRET",
  "SUASOR_CONNECTOR_GOOGLE_REFRESHTOKEN",
  "SUASOR_CONNECTOR_BOX_TOKEN",
  "SUASOR_CONNECTOR_NOTION_TOKEN",
  "SUASOR_CONNECTOR_JIRA_TOKEN",
];

/** Run the CLI capturing stdout/stderr (connector secret envs cleared). */
async function run(
  args: string[],
  stdin: AsyncIterable<Buffer | string> = (async function* () {})(),
  keychain?: KeychainBackend,
  configDir?: string,
): Promise<{ code: number; out: string; err: string }> {
  const saved = SECRET_ENVS.map((k) => [k, process.env[k]] as const);
  for (const k of SECRET_ENVS) delete process.env[k];
  const savedConfigDir = process.env.SUASOR_CONFIG_DIR;
  if (configDir !== undefined) process.env.SUASOR_CONFIG_DIR = configDir;
  let out = "";
  let err = "";
  const cli = buildCli();
  // Built as a variable so the extra `keychain` field (injected via context so
  // token storage never touches the OS keyring) is accepted structurally.
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
    ...(keychain ? { keychain } : {}),
  };
  try {
    const code = await cli.run(args, context);
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

/** In-memory keychain backend that records `set` writes (never touches the OS keyring). */
function memoryKeychain(): KeychainBackend & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: (service, account) => store.get(`${service}/${account}`) ?? null,
    set: (service, account, value) => {
      store.set(`${service}/${account}`, value);
    },
  };
}

/** An async iterable that yields the given chunks then closes (a pipe). */
async function* pipe(...chunks: string[]): AsyncGenerator<string> {
  for (const c of chunks) yield c;
}

describe("suasor <connector> auth — wiring + arg validation (no network)", () => {
  test("all connectors register auth set + auth test in --help", async () => {
    const { code, out } = await run(["--help"]);
    expect(code).toBe(0);
    for (const name of ["github", "ms-graph", "google", "box", "notion", "jira"]) {
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

  test("auth set reads a piped token (trailing newline) and stores it (Issue #383)", async () => {
    const keychain = memoryKeychain();
    const { code, out } = await run(["github", "auth", "set"], pipe("ghp_piped\n"), keychain);
    expect(code).toBe(0);
    expect(out).toContain("Stored github Personal Access Token");
    expect(keychain.store.get(`${KEYCHAIN_SERVICE}/${keychainAccount("github", "token")}`)).toBe(
      "ghp_piped",
    );
  });

  test("auth set reads a piped token with NO trailing newline (pipe compat, Issue #383)", async () => {
    // `printf 'tok' | suasor github auth set` — the stream closes without a
    // newline; the read must still return the buffered token.
    const keychain = memoryKeychain();
    const { code } = await run(["github", "auth", "set"], pipe("ghp_no_newline"), keychain);
    expect(code).toBe(0);
    expect(keychain.store.get(`${KEYCHAIN_SERVICE}/${keychainAccount("github", "token")}`)).toBe(
      "ghp_no_newline",
    );
  });

  test("auth set --token still wins over stdin (no read attempted)", async () => {
    const keychain = memoryKeychain();
    const { code } = await run(
      ["github", "auth", "set", "--token", "ghp_inline"],
      pipe(),
      keychain,
    );
    expect(code).toBe(0);
    expect(keychain.store.get(`${KEYCHAIN_SERVICE}/${keychainAccount("github", "token")}`)).toBe(
      "ghp_inline",
    );
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

  test("notion auth test without a token exits 1 with onboarding guidance", async () => {
    const { code, err } = await run(["notion", "auth", "test"]);
    expect(code).toBe(1);
    expect(err).toContain("no notion token configured");
    expect(err).toContain("notion auth set");
  });

  test("jira auth test without a token exits 1 with onboarding guidance", async () => {
    const { code, err } = await run(["jira", "auth", "test"]);
    expect(code).toBe(1);
    expect(err).toContain("no jira token configured");
    expect(err).toContain("jira auth set");
  });

  // ADR-0049 / Issue #478: the reachability layer is on by default (the operator
  // should not have to know to ask for the layer that answers "will this
  // actually work"), with an explicit opt-out.
  test("auth test documents the resource probe and its --no-probe opt-out", async () => {
    const { code, out } = await run(["google", "auth", "test", "--help"]);
    expect(code).toBe(0);
    expect(out).toContain("--no-probe");
    expect(out).toContain("UNKNOWN");
  });

  test("--no-probe is accepted (it fails only on the missing credential)", async () => {
    const { code, err } = await run(["google", "auth", "test", "--no-probe"]);
    expect(code).toBe(1);
    expect(err).toContain("no google refreshToken configured");
  });
});

describe("AUTH_SPECS table (SSOT)", () => {
  test("covers exactly github / ms-graph / google / box / notion / jira (Slack keeps its own)", () => {
    expect(authConnectorNames()).toEqual(["box", "github", "google", "jira", "ms-graph", "notion"]);
    expect(AUTH_SPECS.slack).toBeUndefined();
  });

  test("the resource-gated connectors declare a reachability probe (ADR-0049)", () => {
    // google / ms-graph are the `resources = [...]` connectors — the ones whose
    // readiness a scope check cannot fully answer (ms-graph cannot answer it at
    // all: client-credentials reports `.default`).
    expect(AUTH_SPECS.google?.probesResources).toBe(true);
    expect(AUTH_SPECS["ms-graph"]?.probesResources).toBe(true);
    // The others have no per-resource notion; absence here is the honest state,
    // not an oversight.
    expect(AUTH_SPECS.github?.probesResources ?? false).toBe(false);
    expect(AUTH_SPECS.box?.probesResources ?? false).toBe(false);
  });

  test("each spec stores the secret name the connector reads at sync time", () => {
    expect(AUTH_SPECS.github?.secretName).toBe("token");
    expect(AUTH_SPECS["ms-graph"]?.secretName).toBe("clientSecret");
    expect(AUTH_SPECS.google?.secretName).toBe("refreshToken");
    expect(AUTH_SPECS.box?.secretName).toBe("token");
    expect(AUTH_SPECS.notion?.secretName).toBe("token");
    expect(AUTH_SPECS.jira?.secretName).toBe("token");
  });

  test("each spec's secretName matches the registry SECRET_NAMES SSOT (no drift)", () => {
    // The registry (src/connectors/registry.ts) owns the connector→secret-name
    // mapping for `connectors list`; `auth set` must store under the same name
    // the connector reads at sync time, so guard the two against drift.
    const pairs = authConnectorNames().map((name) => ({
      specSecret: AUTH_SPECS[name]?.secretName,
      // The connector's *primary* secret is the first the registry lists.
      registryPrimary: connectorSecretNames(name)[0],
    }));
    for (const { specSecret, registryPrimary } of pairs) {
      expect(specSecret).toBe(registryPrimary);
    }
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

  test("jira test throws the no-token error when the secret is absent", async () => {
    await expect(
      AUTH_SPECS.jira?.test({ secret: noSecret, config: { host: "h" } }),
    ).rejects.toThrow(/no jira token configured/);
  });

  test("jira test requires host in config", async () => {
    await expect(
      AUTH_SPECS.jira?.test({ secret: async (n) => (n === "token" ? "tok" : null), config: {} }),
    ).rejects.toThrow(/host is required/);
  });
});

/**
 * A stored credential does nothing on its own: without a `[connectors.<name>]`
 * slice nothing enumerates the connector, so `auth set` alone left the operator
 * with a working token and a connector that silently never synced (Issue #529 /
 * ADR-0029, whose "structural" fix only ever covered the wizard path).
 */
describe("auth set — the config slice it does not write", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "suasor-auth-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function setToken(toml: string): Promise<{ out: string; code: number }> {
    await Bun.write(join(dir, "config.toml"), toml);
    const { code, out } = await run(
      ["github", "auth", "set", "--token", "ghp_x"],
      (async function* () {})(),
      memoryKeychain(),
      dir,
    );
    return { code, out };
  }

  test("says so when the config has no slice for the connector", async () => {
    const { code, out } = await setToken('[storage]\ndbPath = "/tmp/x.db"\n');
    expect(code).toBe(0);
    expect(out).toContain("no [connectors.github] section");
    // Naming the command that fixes it, not just the problem.
    expect(out).toContain("suasor onboard --connector github");
  });

  test("stays quiet when the slice is already there", async () => {
    const { code, out } = await setToken('[connectors.github]\nrepos = ["o/r"]\n');
    expect(code).toBe(0);
    expect(out).not.toContain("no [connectors.github] section");
  });
});

/**
 * `--account` on the auth verbs (ADR-0050 / Issue #441). No network: every case
 * is decided before any probe runs.
 */
describe("auth verbs — per-account targeting", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "suasor-auth-acct-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function withConfig(
    toml: string,
    args: string[],
    keychain = memoryKeychain(),
  ): Promise<{ code: number; out: string; err: string; keychain: typeof keychain }> {
    await Bun.write(join(dir, "config.toml"), `[storage]\ndbPath = "${dir}/x.db"\n${toml}`);
    const result = await run(args, (async function* () {})(), keychain, dir);
    return { ...result, keychain };
  }

  const TWO_ACCOUNTS = [
    "[connectors.google]",
    'clientId = "shared"',
    "[connectors.google.accounts.personal]",
    "[connectors.google.accounts.work]",
    "",
  ].join("\n");

  test("auth set stores the credential under the account-scoped keychain name", async () => {
    const { code, out, keychain } = await withConfig(TWO_ACCOUNTS, [
      "google",
      "auth",
      "set",
      "--account",
      "work",
      "--token",
      "rt_work",
    ]);
    expect(code).toBe(0);
    expect(
      keychain.store.get(`${KEYCHAIN_SERVICE}/${keychainAccount("google", "work:refreshToken")}`),
    ).toBe("rt_work");
    // And it points at the matching verification command, account included.
    expect(out).toContain("google auth test --account work");
  });

  test("auth set refuses to guess which account an ambiguous store is for", async () => {
    // Storing the work token under the personal account's name is invisible
    // until the wrong mailbox syncs — so the ambiguity is refused, not resolved.
    const { code, err } = await withConfig(TWO_ACCOUNTS, [
      "google",
      "auth",
      "set",
      "--token",
      "rt",
    ]);
    expect(code).toBe(1);
    expect(err).toContain("pass --account");
    expect(err).toContain("personal, work");
  });

  test("an unknown account name is refused, listing the configured ones", async () => {
    const { code, err } = await withConfig(TWO_ACCOUNTS, [
      "google",
      "auth",
      "test",
      "--account",
      "wrok",
    ]);
    expect(code).toBe(1);
    expect(err).toContain("no account 'wrok'");
    expect(err).toContain("personal, work");
  });

  test("--account is refused on a connector with no per-account config", async () => {
    const { code, err } = await withConfig('[connectors.github]\nrepos = ["o/r"]\n', [
      "github",
      "auth",
      "test",
      "--account",
      "work",
    ]);
    expect(code).toBe(1);
    expect(err).toContain("no per-account configuration");
    // The connectors that *do* accept it are named, the same way `onboard` names
    // them (#544) — and derived from the manifests, never listed in the CLI.
    expect(err).toContain("google");
    expect(err).toContain("ms-graph");
  });

  test("auth test with no --account reports every account, not just the first", async () => {
    // Both credentials are absent, so both fail before any probe — the point is
    // that *both* are attempted: stopping at the first would report the install
    // as broken in one place while a second dead credential stayed invisible.
    const { code, err } = await withConfig(TWO_ACCOUNTS, ["google", "auth", "test"]);
    expect(code).toBe(1);
    expect(err).toContain("account 'personal': no google refreshToken configured");
    expect(err).toContain("account 'work': no google refreshToken configured");
    expect(err).toContain("google auth set --account work");
  });

  test("a single-account config keeps its unlabelled message", async () => {
    const { code, err } = await withConfig('[connectors.google]\nclientId = "c"\n', [
      "google",
      "auth",
      "test",
    ]);
    expect(code).toBe(1);
    expect(err).toContain("no google refreshToken configured");
    expect(err).not.toContain("account '");
  });

  test("--json emits nothing when no account verified (pre-ADR-0050 behaviour)", async () => {
    // An empty `{"accounts":{}}` would read as a successful probe that found no
    // accounts, when in fact every probe failed (errors went to stderr).
    const { code, out, err } = await withConfig(TWO_ACCOUNTS, ["google", "auth", "test", "--json"]);
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toContain("no google refreshToken configured");
  });

  test("the account flag is documented on both verbs", async () => {
    for (const verb of ["set", "test"]) {
      const { code, out } = await run(["google", "auth", verb, "--help"]);
      expect(code).toBe(0);
      expect(out).toContain("--account");
    }
  });
});

describe("auth set — keychain write failure (#557)", () => {
  test("a keychain write failure prints the env override recovery, not a raw throw", async () => {
    const failing: KeychainBackend = {
      get: () => null,
      set: () => {
        throw new Error("no Secret Service available (headless host)");
      },
    };
    const { code, out, err } = await run(
      ["github", "auth", "set", "--token", "ghp_x"],
      (async function* () {})(),
      failing,
    );
    expect(code).toBe(1);
    expect(out).not.toContain("Stored");
    expect(err).toContain("could not store the github secret");
    expect(err).toContain("no Secret Service available");
    expect(err).toContain("SUASOR_CONNECTOR_GITHUB_TOKEN=<value>");
  });
});
