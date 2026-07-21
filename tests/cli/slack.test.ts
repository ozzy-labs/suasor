import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatConversationRow, slackChannelLabel } from "../../src/cli/commands/slack.ts";
import { buildCli } from "../../src/cli/index.ts";
import {
  KEYCHAIN_SERVICE,
  type KeychainBackend,
  keychainAccount,
} from "../../src/connectors/secrets.ts";

// An isolated, empty config dir per test so workspace resolution (Issue #371
// theme 1) reads a known config shape instead of the developer's real
// `~/.config/suasor/config.toml` (which may carry multiple Slack workspaces and
// would otherwise flip the no-token assertions into an ambiguity error).
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "suasor-cli-slack-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write a `config.toml` into the isolated config dir for the current test. */
function _writeConfig(toml: string): void {
  writeFileSync(join(dir, "config.toml"), toml);
}

/** Run the CLI capturing stdout/stderr (Slack token env cleared for isolation). */
async function run(
  args: string[],
  opts: { stdin?: AsyncIterable<Buffer | string>; keychain?: KeychainBackend } = {},
): Promise<{ code: number; out: string; err: string }> {
  const prevToken = process.env.SUASOR_CONNECTOR_SLACK_TOKENS;
  const prevDir = process.env.SUASOR_CONFIG_DIR;
  delete process.env.SUASOR_CONNECTOR_SLACK_TOKENS;
  process.env.SUASOR_CONFIG_DIR = dir;
  let out = "";
  let err = "";
  const cli = buildCli();
  // Built as a variable so the extra `keychain` field (injected via context so
  // token storage never touches the OS keyring) is accepted structurally.
  const context = {
    stdin: (opts.stdin ?? process.stdin) as unknown as NodeJS.ReadStream,
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
    if (prevToken === undefined) delete process.env.SUASOR_CONNECTOR_SLACK_TOKENS;
    else process.env.SUASOR_CONNECTOR_SLACK_TOKENS = prevToken;
    if (prevDir === undefined) delete process.env.SUASOR_CONFIG_DIR;
    else process.env.SUASOR_CONFIG_DIR = prevDir;
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

describe("suasor slack — wiring + arg validation (no network)", () => {
  test("the slack verbs are registered in --help", async () => {
    const { code, out } = await run(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("slack auth");
    expect(out).toContain("slack conversations");
    // `slack sync` (the per-connector ingest verb) is registered too; its
    // multi-workspace partial-failure summary + exit code is the subject of #166.
    expect(out).toContain("slack sync");
  });

  test("auth test without a configured token pool exits 1 with guidance", async () => {
    const { code, err } = await run(["slack", "auth", "test"]);
    expect(code).toBe(1);
    expect(err).toContain("no Slack token pool configured");
  });

  test("conversations rejects an invalid --types before any token lookup", async () => {
    const { code, err } = await run(["slack", "conversations", "--types", "bogus"]);
    expect(code).toBe(1);
    expect(err).toContain("invalid --types");
  });

  test("conversations rejects a non-positive --limit", async () => {
    const { code, err } = await run(["slack", "conversations", "--limit", "0"]);
    expect(code).toBe(1);
    expect(err).toContain("--limit must be a positive integer");
  });

  test("conversations without a configured token pool exits 1 with guidance", async () => {
    const { code, err } = await run(["slack", "conversations"]);
    expect(code).toBe(1);
    expect(err).toContain("no Slack token pool configured");
  });

  test("--workspace is gone (ADR-0042): the flag is rejected", async () => {
    const { code } = await run(["slack", "auth", "test", "--workspace", "acme"]);
    // clipanion rejects the unknown option before the command body runs.
    expect(code).not.toBe(0);
  });

  test("auth set reads a piped token (trailing newline) and stores the pool (Issue #383)", async () => {
    const keychain = memoryKeychain();
    const { code, out } = await run(["slack", "auth", "set"], {
      stdin: pipe("xoxb-piped\n"),
      keychain,
    });
    expect(code).toBe(0);
    expect(out).toContain("Stored 1 Slack token(s)");
    expect(keychain.store.get(`${KEYCHAIN_SERVICE}/${keychainAccount("slack", "tokens")}`)).toBe(
      "xoxb-piped",
    );
  });

  test("auth set stores a comma-separated pool newline-normalised (ADR-0042)", async () => {
    const keychain = memoryKeychain();
    const { code, out } = await run(["slack", "auth", "set", "--token", "xoxb-a, xoxp-b"], {
      keychain,
    });
    expect(code).toBe(0);
    expect(out).toContain("Stored 2 Slack token(s)");
    expect(keychain.store.get(`${KEYCHAIN_SERVICE}/${keychainAccount("slack", "tokens")}`)).toBe(
      "xoxb-a\nxoxp-b",
    );
  });

  test("auth set reads a piped token with NO trailing newline (pipe compat, Issue #383)", async () => {
    // `printf 'xoxb-…' | suasor slack auth set` — no trailing newline, then EOF.
    const keychain = memoryKeychain();
    const { code } = await run(["slack", "auth", "set"], {
      stdin: pipe("xoxb-no-newline"),
      keychain,
    });
    expect(code).toBe(0);
    expect(keychain.store.get(`${KEYCHAIN_SERVICE}/${keychainAccount("slack", "tokens")}`)).toBe(
      "xoxb-no-newline",
    );
  });

  test("the no-token guidance names the pool env override (ADR-0042)", async () => {
    const { err } = await run(["slack", "auth", "test"]);
    expect(err).toContain("SUASOR_CONNECTOR_SLACK_TOKENS");
    const flat = await run(["slack", "conversations"]);
    expect(flat.err).toContain("SUASOR_CONNECTOR_SLACK_TOKENS");
  });

  test("conversations rejects an invalid --sort before any token lookup (ADR-0013)", async () => {
    const { code, err } = await run(["slack", "conversations", "--sort", "bogus"]);
    expect(code).toBe(1);
    expect(err).toContain("invalid --sort");
  });

  test("conversations --no-progress is accepted and arg validation still runs first (#84)", async () => {
    // --no-progress is a registered flag; bad --types still fails fast before any
    // token / network / progress work.
    const { code, err } = await run([
      "slack",
      "conversations",
      "--no-progress",
      "--types",
      "bogus",
    ]);
    expect(code).toBe(1);
    expect(err).toContain("invalid --types");
  });
});

describe("slack conversations — joined mark (ADR-0011, #165)", () => {
  test("a joined channel gets a ✓; an unjoined channel gets a blank cell", () => {
    const joined = formatConversationRow({
      id: "C1",
      displayName: "#general",
      isArchived: false,
      isMember: true,
    });
    const unjoined = formatConversationRow({
      id: "C2",
      displayName: "#locked",
      isArchived: false,
      isMember: false,
    });
    expect(joined).toContain("✓");
    expect(joined).toContain("C1");
    expect(joined).toContain("#general");
    expect(unjoined).not.toContain("✓");
    expect(unjoined).toContain("C2");
    // The id column stays aligned across joined/unjoined rows (mark is one cell).
    expect(joined.indexOf("C1")).toBe(unjoined.indexOf("C2"));
  });

  test("the engagement suffix and (archived) flag still render", () => {
    const row = formatConversationRow(
      { id: "C3", displayName: "#old", isArchived: true, isMember: true },
      "  last_self_post=2026-01-01 00:00 (5mo ago)",
    );
    expect(row).toContain("(archived)");
    expect(row).toContain("last_self_post=2026-01-01");
  });
});

describe("slackChannelLabel — kind-aware display (ADR-0037)", () => {
  test("public/private channels get a `#` prefix", () => {
    expect(slackChannelLabel("general", "public")).toBe("#general");
    expect(slackChannelLabel("secret", "private")).toBe("#secret");
  });

  test("a single DM gets an `@` prefix (the counterpart)", () => {
    expect(slackChannelLabel("Ada Lovelace", "dm")).toBe("@Ada Lovelace");
  });

  test("a group DM keeps the participant-name join as-is", () => {
    expect(slackChannelLabel("Ada, Grace", "group")).toBe("Ada, Grace");
  });
});
