import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chooseWorkspaceAlias,
  formatConversationRow,
  slackChannelLabel,
} from "../../src/cli/commands/slack.ts";
import { buildCli } from "../../src/cli/index.ts";

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
function writeConfig(toml: string): void {
  writeFileSync(join(dir, "config.toml"), toml);
}

/** Run the CLI capturing stdout/stderr (Slack token env cleared for isolation). */
async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const prevToken = process.env.SUASOR_CONNECTOR_SLACK_TOKEN;
  const prevDir = process.env.SUASOR_CONFIG_DIR;
  delete process.env.SUASOR_CONNECTOR_SLACK_TOKEN;
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
    if (prevToken === undefined) delete process.env.SUASOR_CONNECTOR_SLACK_TOKEN;
    else process.env.SUASOR_CONNECTOR_SLACK_TOKEN = prevToken;
    if (prevDir === undefined) delete process.env.SUASOR_CONFIG_DIR;
    else process.env.SUASOR_CONFIG_DIR = prevDir;
  }
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

  test("auth test without a configured token exits 1 with guidance", async () => {
    const { code, err } = await run(["slack", "auth", "test"]);
    expect(code).toBe(1);
    expect(err).toContain("no Slack token configured");
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

  test("conversations without a configured token exits 1 with guidance", async () => {
    const { code, err } = await run(["slack", "conversations"]);
    expect(code).toBe(1);
    expect(err).toContain("no Slack token configured");
  });

  test("--workspace flows into the no-token guidance (ADR-0014)", async () => {
    const { code, err } = await run(["slack", "auth", "test", "--workspace", "acme"]);
    expect(code).toBe(1);
    expect(err).toContain("auth set --workspace acme");
  });

  test("the no-token guidance names the env override (Issue #371 theme 4)", async () => {
    const { err } = await run(["slack", "auth", "test", "--workspace", "acme-eu"]);
    // A `-` in the alias normalises to `_` in the env override name (#8).
    expect(err).toContain("SUASOR_CONNECTOR_SLACK_ACME_EU_TOKEN");
    const flat = await run(["slack", "conversations"]);
    expect(flat.err).toContain("SUASOR_CONNECTOR_SLACK_TOKEN");
  });

  test("a sole named workspace is auto-selected when --workspace is omitted (theme 1)", async () => {
    writeConfig('[connectors.slack.workspaces.acme]\nteam = "T1"\nchannels = []\n');
    const { code, err } = await run(["slack", "auth", "test"]);
    // Resolves to the one configured alias (not a silent flat `token` lookup), so
    // the token-missing error names that workspace + its env override.
    expect(code).toBe(1);
    expect(err).toContain("workspace 'acme'");
    expect(err).toContain("SUASOR_CONNECTOR_SLACK_ACME_TOKEN");
  });

  test("multiple workspaces with no default error with the alias list (theme 1)", async () => {
    writeConfig(
      '[connectors.slack.workspaces.acme]\nteam = "T1"\nchannels = []\n' +
        '[connectors.slack.workspaces.beta]\nteam = "T2"\nchannels = []\n',
    );
    const { code, err } = await run(["slack", "conversations"]);
    expect(code).toBe(1);
    expect(err).toContain("multiple Slack workspaces configured");
    expect(err).toContain("acme");
    expect(err).toContain("beta");
    expect(err).toContain("--workspace");
  });

  test("multiple workspaces with a default alias fall back to it (theme 1)", async () => {
    writeConfig(
      '[connectors.slack.workspaces.default]\nteam = "T1"\nchannels = []\n' +
        '[connectors.slack.workspaces.beta]\nteam = "T2"\nchannels = []\n',
    );
    const { code, err } = await run(["slack", "auth", "test"]);
    // No ambiguity error: it resolves to `default` and fails only on the token.
    expect(code).toBe(1);
    expect(err).not.toContain("multiple Slack workspaces configured");
    expect(err).toContain("no Slack token configured");
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

describe("chooseWorkspaceAlias — --workspace resolution (Issue #371 theme 1)", () => {
  test("an explicit --workspace always wins", () => {
    expect(chooseWorkspaceAlias("acme", [])).toEqual({ ok: true, alias: "acme" });
    expect(chooseWorkspaceAlias("acme", ["beta", "gamma"])).toEqual({ ok: true, alias: "acme" });
  });

  test("a flat config (no aliases) resolves to undefined (the `token` secret)", () => {
    expect(chooseWorkspaceAlias(undefined, [])).toEqual({ ok: true, alias: undefined });
  });

  test("a sole named workspace is auto-selected", () => {
    expect(chooseWorkspaceAlias(undefined, ["acme"])).toEqual({ ok: true, alias: "acme" });
  });

  test("2+ aliases with no default is ambiguous (lists the aliases)", () => {
    expect(chooseWorkspaceAlias(undefined, ["acme", "beta"])).toEqual({
      ok: false,
      aliases: ["acme", "beta"],
    });
  });

  test("2+ aliases with a default alias fall back to default", () => {
    expect(chooseWorkspaceAlias(undefined, ["beta", "default"])).toEqual({
      ok: true,
      alias: "default",
    });
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
