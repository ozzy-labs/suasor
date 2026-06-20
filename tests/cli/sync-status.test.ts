/**
 * `suasor sync status` — per-connector freshness view (ADR-0033 / Issue #201).
 *
 * Verifies that the command reads the `sync_runs` projection and shows the last
 * sync time / counts / outcome, that never-synced connectors are surfaced, and
 * that --json emits a machine-readable array. Seeds the projection by recording
 * SyncRunStarted / SyncRunEnded events through the Store (same path the shared
 * sync service uses), so the test exercises reducer + read query + CLI together.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCli } from "../../src/cli/index.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "suasor-cli-sync-status-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Run the CLI capturing stdout/stderr; uses SUASOR_CONFIG_DIR for isolation. */
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

/** Write a config enabling the named connectors so the CLI loads cleanly. */
function writeConfig(connectors: string[]): void {
  const slices = connectors.map((c) => `[connectors.${c}]\nenabled = true`).join("\n");
  writeFileSync(
    join(dir, "config.toml"),
    `[storage]\ndbPath = "${join(dir, "suasor.db")}"\n\n${slices}\n`,
  );
}

/** Record a completed sync run for a connector into the db the CLI opens. */
async function seedRun(
  connector: string,
  opts: {
    status?: "ok" | "partial" | "error";
    observed?: number;
    updated?: number;
    unchanged?: number;
    durationMs?: number;
    error?: string;
    startedAt?: string;
    endedAt?: string;
  } = {},
): Promise<void> {
  const { Store } = await import("../../src/db/index.ts");
  const store = Store.open({ path: join(dir, "suasor.db") });
  const startedAt = opts.startedAt ?? "2026-06-14T00:00:00.000Z";
  const runId = `${connector}:${startedAt}`;
  store.record({ type: "SyncRunStarted", connector, runId, startedAt }, new Date(startedAt));
  store.record(
    {
      type: "SyncRunEnded",
      connector,
      runId,
      status: opts.status ?? "ok",
      observed: opts.observed ?? 0,
      updated: opts.updated ?? 0,
      unchanged: opts.unchanged ?? 0,
      durationMs: opts.durationMs ?? 0,
      ...(opts.error !== undefined ? { error: opts.error } : {}),
    },
    new Date(opts.endedAt ?? "2026-06-14T00:00:01.000Z"),
  );
  store.close();
}

describe("suasor sync status", () => {
  test("shows the latest run's time / counts / outcome per connector", async () => {
    writeConfig(["github"]);
    await seedRun("github", {
      status: "ok",
      observed: 3,
      updated: 1,
      unchanged: 7,
      durationMs: 1234,
    });

    const { code, out } = await run(["sync", "status"]);
    expect(code).toBe(0);
    expect(out).toContain("github: ok");
    expect(out).toContain("3 observed, 1 updated, 7 unchanged");
    expect(out).toContain("2026-06-14T00:00:01.000Z");
    expect(out).toContain("1234ms");
  });

  test("surfaces an enabled connector that has never synced", async () => {
    writeConfig(["github"]);
    const { code, out } = await run(["sync", "status"]);
    expect(code).toBe(0);
    expect(out).toContain("github: never synced");
  });

  test("shows the error message for a failed run", async () => {
    writeConfig(["slack"]);
    await seedRun("slack", { status: "error", error: "token expired" });
    const { code, out } = await run(["sync", "status"]);
    expect(code).toBe(0);
    expect(out).toContain("slack: error");
    expect(out).toContain("token expired");
  });

  test("--json emits machine-readable rows including never-synced", async () => {
    writeConfig(["github", "slack"]);
    await seedRun("github", { status: "ok", observed: 2 });

    const { code, out } = await run(["sync", "status", "--json"]);
    expect(code).toBe(0);
    const rows = JSON.parse(out) as Array<{
      connector: string;
      status: string;
      observed?: number;
    }>;
    const gh = rows.find((r) => r.connector === "github");
    const sl = rows.find((r) => r.connector === "slack");
    expect(gh?.status).toBe("ok");
    expect(gh?.observed).toBe(2);
    expect(sl?.status).toBe("never_synced");
  });
});
