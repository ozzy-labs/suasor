/**
 * `suasor slack resolve-names` (ADR-0037 §11) CLI wiring, network-free. The
 * resolution engine itself is covered with fakes in
 * tests/connectors/slack/backfill.test.ts; here we assert the command is
 * registered, parses its flags, reports its summary, and — crucially — reaches no
 * network on the paths a test can exercise (already-named ids are skipped; a
 * tokenless workspace is skipped).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCli } from "../../src/cli/index.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "suasor-cli-resolve-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const prev = process.env.SUASOR_CONFIG_DIR;
  const prevTok = process.env.SUASOR_CONNECTOR_SLACK_TOKEN;
  process.env.SUASOR_CONFIG_DIR = dir;
  delete process.env.SUASOR_CONNECTOR_SLACK_TOKEN;
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
    if (prevTok === undefined) delete process.env.SUASOR_CONNECTOR_SLACK_TOKEN;
    else process.env.SUASOR_CONNECTOR_SLACK_TOKEN = prevTok;
  }
}

/** Insert a `slack_message` source directly, so the backfill has ids to scan. */
async function seedSource(meta: { team: string; channel?: string; user?: string }): Promise<void> {
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
      const id = `slack:${meta.team}:${meta.channel ?? meta.user}:1`;
      store.connection.sqlite
        .query(
          `INSERT INTO sources (external_id, source_type, body, fingerprint, observed_at, meta)
           VALUES ($id, 'slack_message', 'hi', $id, '1970-01-01T00:00:00.000Z', $meta)`,
        )
        .run({ $id: id, $meta: JSON.stringify(meta) });
    } finally {
      store.close();
    }
  } finally {
    if (prev === undefined) delete process.env.SUASOR_CONFIG_DIR;
    else process.env.SUASOR_CONFIG_DIR = prev;
  }
}

describe("suasor slack resolve-names (ADR-0037 §11)", () => {
  test("is registered under the slack verbs in --help", async () => {
    const { code, out } = await run(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("slack resolve-names");
  });

  test("with no slack_message sources → an all-zero summary (no network)", async () => {
    await run(["init"]);
    const { code, out } = await run(["slack", "resolve-names"]);
    expect(code).toBe(0);
    expect(out).toContain("channels: 0 resolved, 0 already named");
    expect(out).toContain("users:    0 resolved, 0 already named");
  });

  test("--json emits the structured summary", async () => {
    await run(["init"]);
    const { code, out } = await run(["slack", "resolve-names", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.channels).toEqual({ resolved: 0, skipped: 0, degraded: 0 });
    expect(parsed.users).toEqual({ resolved: 0, skipped: 0, degraded: 0 });
    expect(parsed.tokenlessWorkspaces).toEqual([]);
    expect(parsed.orphanTeamIds).toBe(0);
  });

  test("a tokenless workspace with ingested ids is skipped, not fetched", async () => {
    await run(["init"]);
    // A source under team `default` (the flat/default workspace), but no token
    // configured → the workspace is skipped whole, so nothing reaches Slack.
    await seedSource({ team: "default", channel: "C1", user: "U1" });
    const { code, out, err } = await run(["slack", "resolve-names"]);
    expect(code).toBe(0);
    expect(out).toContain("channels: 0 resolved");
    expect(err).toContain("skipped workspace(s) with no token: default");
  });

  test("ids under a team no workspace claims are reported as orphans (no network)", async () => {
    await run(["init"]);
    await seedSource({ team: "TX", channel: "CX", user: "UX" });
    const { code, out } = await run(["slack", "resolve-names", "--json"]);
    expect(code).toBe(0);
    // No configured workspace has team `TX` → both ids are orphans, none fetched.
    expect(JSON.parse(out).orphanTeamIds).toBe(2);
  });
});
