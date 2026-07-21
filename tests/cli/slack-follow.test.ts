/**
 * `suasor slack follow` / `slack unfollow` (ADR-0042 決定 6): name-based channel
 * selection over the token pool + surgical config edits. Network goes through
 * the shared `fetch` seam (the same pattern as the conversations tests); the
 * pool comes from the `SUASOR_CONNECTOR_SLACK_TOKENS` env override.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveNameRefs } from "../../src/cli/commands/slack-follow.ts";
import { buildCli } from "../../src/cli/index.ts";
import type { SlackConversation } from "../../src/connectors/slack/conversations.ts";

let realFetch: typeof fetch;
let savedToken: string | undefined;
let savedDir: string | undefined;
let dir: string;

beforeEach(() => {
  realFetch = globalThis.fetch;
  savedToken = process.env.SUASOR_CONNECTOR_SLACK_TOKENS;
  process.env.SUASOR_CONNECTOR_SLACK_TOKENS = "xoxb-test-token";
  savedDir = process.env.SUASOR_CONFIG_DIR;
  dir = mkdtempSync(join(tmpdir(), "suasor-cli-follow-"));
  process.env.SUASOR_CONFIG_DIR = dir;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedToken === undefined) delete process.env.SUASOR_CONNECTOR_SLACK_TOKENS;
  else process.env.SUASOR_CONNECTOR_SLACK_TOKENS = savedToken;
  if (savedDir === undefined) delete process.env.SUASOR_CONFIG_DIR;
  else process.env.SUASOR_CONFIG_DIR = savedDir;
  rmSync(dir, { recursive: true, force: true });
});

/** Fake Slack API: users.conversations returns the given channels per type. */
function installFetch(publicChannels: Record<string, unknown>[]): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    const u = new URL(url);
    calls.push(u.pathname.replace("/api/", ""));
    if (url.includes("users.conversations")) {
      const chans = u.searchParams.get("types") === "public_channel" ? publicChannels : [];
      return new Response(JSON.stringify({ ok: true, channels: chans }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false, error: "unexpected" }), { status: 200 });
  }) as typeof fetch;
  return { calls };
}

async function run(
  args: string[],
  opts: { stdin?: AsyncIterable<Buffer | string> } = {},
): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const cli = buildCli();
  const code = await cli.run(args, {
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
  });
  return { code, out, err };
}

async function* pipe(...chunks: string[]): AsyncGenerator<string> {
  for (const c of chunks) yield c;
}

function writeConfig(toml: string): void {
  writeFileSync(join(dir, "config.toml"), toml);
}

function row(over: Partial<SlackConversation> & { id: string }): SlackConversation {
  return {
    type: "public",
    name: over.id.toLowerCase(),
    displayName: `#${over.id.toLowerCase()}`,
    isArchived: false,
    isMember: true,
    ...over,
  } as SlackConversation;
}

describe("resolveNameRefs (pure)", () => {
  const visible = [
    row({ id: "C1", name: "general", displayName: "#general", teamId: "T1" }),
    row({ id: "C2", name: "general", displayName: "#general", teamId: "T2" }),
    row({ id: "C3", name: "eng", displayName: "#eng", teamId: "T1" }),
    // The same channel visible via two teams (Grid-shared) is ONE id → not ambiguous.
    row({ id: "C3", name: "eng", displayName: "#eng", teamId: "T2" }),
  ];

  test("resolves an unambiguous name (leading # optional; shared channel is one id)", () => {
    const r = resolveNameRefs(["#eng", "eng"], visible);
    expect(r.resolved.map((x) => x.id)).toEqual(["C3", "C3"]);
    expect(r.ambiguous.size).toBe(0);
    expect(r.notFound).toEqual([]);
  });

  test("two distinct ids for one name is ambiguous; unknown names are notFound", () => {
    const r = resolveNameRefs(["#general", "#nope"], visible);
    expect(r.resolved).toEqual([]);
    expect([...r.ambiguous.keys()]).toEqual(["#general"]);
    expect(r.ambiguous.get("#general")?.map((c) => c.id)).toEqual(["C1", "C2"]);
    expect(r.notFound).toEqual(["#nope"]);
  });
});

describe("suasor slack follow", () => {
  test("follow by id needs no network and appends to config", async () => {
    await run(["init"]);
    writeConfig('[connectors.slack]\nchannels = ["C0"]\n');
    const { calls } = installFetch([]);
    const { code, out } = await run(["slack", "follow", "C0123ABCD"]);
    expect(code).toBe(0);
    expect(calls).toEqual([]); // id refs never sweep
    expect(out).toContain("now following 1 channel(s): C0123ABCD");
    const toml = await Bun.file(join(dir, "config.toml")).text();
    expect(toml).toContain('"C0123ABCD"');
    expect(toml).toContain('"C0"'); // existing entry survives
  });

  test("follow by name resolves across the pool and stores the id + label", async () => {
    await run(["init"]);
    writeConfig("[connectors.slack]\nchannels = []\n");
    installFetch([{ id: "C_ENG", name: "eng", is_member: true }]);
    const { code, out } = await run(["slack", "follow", "#eng"]);
    expect(code).toBe(0);
    expect(out).toContain("now following 1 channel(s): C_ENG");
    const toml = await Bun.file(join(dir, "config.toml")).text();
    expect(toml).toContain('"C_ENG",  # #eng'); // id is truth, name is a comment
  });

  test("an ambiguous name errors with the candidates and changes nothing", async () => {
    await run(["init"]);
    writeConfig("[connectors.slack]\nchannels = []\n");
    installFetch([
      { id: "C_A", name: "general", is_member: true },
      { id: "C_B", name: "general", is_member: true },
    ]);
    const { code, err } = await run(["slack", "follow", "#general"]);
    expect(code).toBe(1);
    expect(err).toContain("ambiguous");
    expect(err).toContain("C_A");
    expect(err).toContain("C_B");
    const toml = await Bun.file(join(dir, "config.toml")).text();
    expect(toml).not.toContain("C_A");
  });

  test("--suggest proposes joined channels and applies on piped 'y' (one confirm)", async () => {
    await run(["init"]);
    writeConfig('[connectors.slack]\nchannels = ["C_OLD"]\n');
    installFetch([
      { id: "C_OLD", name: "old", is_member: true }, // already configured → not suggested
      { id: "C_NEW", name: "fresh", is_member: true },
      { id: "C_OUT", name: "lurk", is_member: false }, // not joined → not suggested
    ]);
    const { code, out } = await run(["slack", "follow", "--suggest"], { stdin: pipe("y\n") });
    expect(code).toBe(0);
    expect(out).toContain("1 joined channel(s) not yet in config:");
    expect(out).toContain("C_NEW");
    expect(out).not.toContain("C_OUT");
    expect(out).toContain("now following 1 channel(s): C_NEW");
    const toml = await Bun.file(join(dir, "config.toml")).text();
    expect(toml).toContain('"C_NEW",  # #fresh');
  });

  test("--suggest aborts on 'n' without touching the config", async () => {
    await run(["init"]);
    writeConfig("[connectors.slack]\nchannels = []\n");
    installFetch([{ id: "C_NEW", name: "fresh", is_member: true }]);
    const { code, out } = await run(["slack", "follow", "--suggest"], { stdin: pipe("n\n") });
    expect(code).toBe(0);
    expect(out).toContain("aborted — nothing changed.");
    const toml = await Bun.file(join(dir, "config.toml")).text();
    expect(toml).not.toContain("C_NEW");
  });

  test("--suggest --yes applies without a prompt (headless)", async () => {
    await run(["init"]);
    writeConfig("[connectors.slack]\nchannels = []\n");
    installFetch([{ id: "C_NEW", name: "fresh", is_member: true }]);
    const { code, out } = await run(["slack", "follow", "--suggest", "--yes"]);
    expect(code).toBe(0);
    expect(out).toContain("now following 1 channel(s): C_NEW");
  });

  test("no args and no --suggest errors", async () => {
    const { code, err } = await run(["slack", "follow"]);
    expect(code).toBe(1);
    expect(err).toContain("--suggest");
  });

  test("a legacy multi-workspace config fails with the migration error", async () => {
    await run(["init"]);
    writeConfig('[connectors.slack.workspaces.acme]\nteam = "T1"\nchannels = []\n');
    installFetch([]);
    const { code, err } = await run(["slack", "follow", "C1"]);
    expect(code).toBe(1);
    expect(err).toContain("remove 'workspaces'");
  });
});

describe("suasor slack unfollow", () => {
  test("unfollow by id removes the entry (others survive)", async () => {
    await run(["init"]);
    writeConfig('[connectors.slack]\nchannels = [\n  "C1",  # #general\n  "C2",  # #random\n]\n');
    const { code, out } = await run(["slack", "unfollow", "C1"]);
    expect(code).toBe(0);
    expect(out).toContain("unfollowed 1 channel(s): C1");
    const toml = await Bun.file(join(dir, "config.toml")).text();
    expect(toml).not.toContain('"C1"');
    expect(toml).toContain('"C2",  # #random');
  });

  test("unfollow by name resolves offline via the slack_channels projection", async () => {
    await run(["init"]);
    writeConfig('[connectors.slack]\nchannels = [\n  "C1",  # #general\n]\n');
    // Seed the projection (no network): C1 is named "general".
    const prev = process.env.SUASOR_CONFIG_DIR;
    process.env.SUASOR_CONFIG_DIR = dir;
    try {
      const { loadConfig } = await import("../../src/config/index.ts");
      const { Store } = await import("../../src/db/index.ts");
      const config = await loadConfig();
      const store = Store.open({
        path: config.storage.dbPath as string,
        embeddingDim: config.embedding.dim,
      });
      try {
        store.record({
          type: "SlackChannelObserved",
          channelId: "C1",
          teamId: "T1",
          displayName: "general",
          kind: "public",
        });
      } finally {
        store.close();
      }
    } finally {
      if (prev === undefined) delete process.env.SUASOR_CONFIG_DIR;
      else process.env.SUASOR_CONFIG_DIR = prev;
    }
    const { code, out } = await run(["slack", "unfollow", "#general"]);
    expect(code).toBe(0);
    expect(out).toContain("unfollowed 1 channel(s): C1");
  });

  test("an unknown name errors with the id guidance", async () => {
    await run(["init"]);
    writeConfig('[connectors.slack]\nchannels = ["C1"]\n');
    const { code, err } = await run(["slack", "unfollow", "#nope"]);
    expect(code).toBe(1);
    expect(err).toContain("pass the id");
  });

  test("an id not in config reports not-following", async () => {
    await run(["init"]);
    writeConfig('[connectors.slack]\nchannels = ["C1"]\n');
    const { code, out } = await run(["slack", "unfollow", "C9"]);
    expect(code).toBe(0);
    expect(out).toContain("not following: C9");
    expect(out).toContain("nothing removed.");
  });
});
