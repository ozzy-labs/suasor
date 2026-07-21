/**
 * `suasor slack status` / `slack cursor reset` (ADR-0016) end-to-end against a
 * real on-disk store. A Slack `ConnectorSyncCompleted` cursor is seeded directly
 * via the Store, then the CLI reads/mutates it — no network or token needed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCli } from "../../src/cli/index.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "suasor-cli-cursor-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

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

/** Seed a Slack resume cursor by appending a ConnectorSyncCompleted event. */
async function seedCursor(cursor: string): Promise<void> {
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
      store.record({ type: "ConnectorSyncCompleted", connector: "slack", cursor, count: 0 });
    } finally {
      store.close();
    }
  } finally {
    if (prev === undefined) delete process.env.SUASOR_CONFIG_DIR;
    else process.env.SUASOR_CONFIG_DIR = prev;
  }
}

/**
 * Seed a `slack_channels` projection row by appending a SlackChannelObserved
 * event (ADR-0037 §3), so the CLI can join channel id → name at display time.
 */
async function seedChannel(
  channelId: string,
  displayName: string,
  kind: "public" | "private" | "group" | "dm",
): Promise<void> {
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
        channelId,
        teamId: "T1",
        displayName,
        kind,
      });
    } finally {
      store.close();
    }
  } finally {
    if (prev === undefined) delete process.env.SUASOR_CONFIG_DIR;
    else process.env.SUASOR_CONFIG_DIR = prev;
  }
}

/** Seed a `slack_teams` projection row via a SlackTeamObserved event (ADR-0037 §10). */
async function _seedTeam(teamId: string, displayName: string): Promise<void> {
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
      store.record({ type: "SlackTeamObserved", teamId, displayName });
    } finally {
      store.close();
    }
  } finally {
    if (prev === undefined) delete process.env.SUASOR_CONFIG_DIR;
    else process.env.SUASOR_CONFIG_DIR = prev;
  }
}

describe("suasor slack status / cursor reset (ADR-0016)", () => {
  test("status reads a legacy nested (per-alias) cursor flattened (ADR-0042)", async () => {
    await run(["init"]);
    // Pre-ADR-0042 nested cursor: channels flatten with a max-ts merge.
    await seedCursor(JSON.stringify({ acme: { C1: "111.000000" }, beta: { C1: "222.000000" } }));
    const { code, out } = await run(["slack", "status", "--json"]);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ C1: "222.000000" });
  });

  test("status reports no cursor on a fresh store", async () => {
    await run(["init"]);
    const { code, out } = await run(["slack", "status"]);
    expect(code).toBe(0);
    expect(out).toContain("(none");
  });

  test("status prints the per-channel cursor with a humanized ts (#84)", async () => {
    await run(["init"]);
    await seedCursor(JSON.stringify({ C1: "111.000000", C2: "222.000000" }));
    const { code, out } = await run(["slack", "status"]);
    expect(code).toBe(0);
    // The raw epoch ts is rendered as a local "YYYY-MM-DD HH:MM (… ago)" column;
    // the channel id is kept and the date prefix is deterministic (1970-01-01).
    expect(out).toContain("C1  1970-01-01");
    expect(out).toContain("C2  1970-01-01");
    expect(out).toContain("ago)"); // relative phrasing present
    expect(out).not.toContain("C1  111.000000"); // raw ts no longer shown in the table
  });

  test("status --json emits the cursor map", async () => {
    await run(["init"]);
    await seedCursor(JSON.stringify({ C1: "111.000000" }));
    const { code, out } = await run(["slack", "status", "--json"]);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ C1: "111.000000" });
  });

  test("status names channels from the slack_channels projection (ADR-0037 §1)", async () => {
    await run(["init"]);
    await seedCursor(JSON.stringify({ C1: "111.000000", D2: "222.000000" }));
    await seedChannel("C1", "general", "public");
    await seedChannel("D2", "Ada Lovelace", "dm");
    const { code, out } = await run(["slack", "status"]);
    expect(code).toBe(0);
    // Public channel → `#name`; single DM → `@name`; both keep the id prefix.
    expect(out).toContain("C1  #general  1970-01-01");
    expect(out).toContain("D2  @Ada Lovelace  1970-01-01");
  });

  test("status leaves an unresolved channel id-only (no regression, ADR-0037 §6)", async () => {
    await run(["init"]);
    await seedCursor(JSON.stringify({ C1: "111.000000", C9: "999.000000" }));
    await seedChannel("C1", "general", "public");
    // C9 has no projection row → falls back to the raw id (two spaces, no name).
    const { out } = await run(["slack", "status"]);
    expect(out).toContain("C1  #general  1970-01-01");
    expect(out).toContain("C9  1970-01-01");
    expect(out).not.toContain("C9  #");
  });

  test("status --json adds a `names` sibling but keeps the cursor map (ADR-0037 §1)", async () => {
    await run(["init"]);
    await seedCursor(JSON.stringify({ C1: "111.000000" }));
    await seedChannel("C1", "general", "public");
    const { code, out } = await run(["slack", "status", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    // The flat cursor keys are untouched; names is a raw-name sidecar.
    expect(parsed.C1).toBe("111.000000");
    expect(parsed.names).toEqual({ C1: "general" });
  });

  test("status --json omits `names` when nothing is resolved (exact prior shape)", async () => {
    await run(["init"]);
    await seedCursor(JSON.stringify({ C1: "111.000000" }));
    const { out } = await run(["slack", "status", "--json"]);
    expect(JSON.parse(out)).toEqual({ C1: "111.000000" });
  });

  test("cursor reset preview names the targeted channel (ADR-0037 §1)", async () => {
    await run(["init"]);
    await seedCursor(JSON.stringify({ C1: "111.000000" }));
    await seedChannel("C1", "general", "public");
    const preview = await run(["slack", "cursor", "reset", "--channel", "C1"]);
    expect(preview.code).toBe(0);
    expect(preview.out).toContain("C1 #general");
  });

  test("cursor backfill preview names the targeted channel (ADR-0037 §1)", async () => {
    await run(["init"]);
    await seedCursor(JSON.stringify({ C1: "999999999.000000" }));
    await seedChannel("C1", "general", "public");
    const preview = await run([
      "slack",
      "cursor",
      "backfill",
      "--channel",
      "C1",
      "--since",
      "2026-01-01",
    ]);
    expect(preview.code).toBe(0);
    expect(preview.out).toContain("C1 #general:");
  });

  test("cursor reset without --yes previews and does not mutate", async () => {
    await run(["init"]);
    await seedCursor(JSON.stringify({ C1: "111.000000", C2: "222.000000" }));
    const preview = await run(["slack", "cursor", "reset", "--channel", "C1"]);
    expect(preview.code).toBe(0);
    expect(preview.out).toContain("would reset");
    expect(preview.out).toContain("C1");
    // Unchanged: C1 still present.
    const status = await run(["slack", "status", "--json"]);
    expect(JSON.parse(status.out)).toEqual({ C1: "111.000000", C2: "222.000000" });
  });

  test("cursor reset --yes removes the channel; others remain", async () => {
    await run(["init"]);
    await seedCursor(JSON.stringify({ C1: "111.000000", C2: "222.000000" }));
    const reset = await run(["slack", "cursor", "reset", "--channel", "C1", "--yes"]);
    expect(reset.code).toBe(0);
    expect(reset.out).toContain("reset:");
    const status = await run(["slack", "status", "--json"]);
    expect(JSON.parse(status.out)).toEqual({ C2: "222.000000" });
  });

  test("cursor reset --all --yes clears everything", async () => {
    await run(["init"]);
    await seedCursor(JSON.stringify({ C1: "111.000000", C9: "9.000000" }));
    const reset = await run(["slack", "cursor", "reset", "--all", "--yes"]);
    expect(reset.code).toBe(0);
    const status = await run(["slack", "status"]);
    expect(status.out).toContain("(none");
  });

  test("cursor reset with neither --channel nor --all errors", async () => {
    await run(["init"]);
    const { code, err } = await run(["slack", "cursor", "reset"]);
    expect(code).toBe(1);
    expect(err).toContain("--channel");
  });

  test("cursor backfill without --yes previews and does not mutate (#57)", async () => {
    await run(["init"]);
    await seedCursor(JSON.stringify({ C1: "999999999.000000" }));
    const preview = await run([
      "slack",
      "cursor",
      "backfill",
      "--channel",
      "C1",
      "--since",
      "2026-01-01",
    ]);
    expect(preview.code).toBe(0);
    expect(preview.out).toContain("would backfill");
    const status = await run(["slack", "status", "--json"]);
    expect(JSON.parse(status.out)).toEqual({ C1: "999999999.000000" });
  });

  test("cursor backfill --yes lowers the channel cursor to the floor (#57)", async () => {
    await run(["init"]);
    await seedCursor(JSON.stringify({ C1: "999999999.000000" }));
    const floorTs = `${Math.floor(Date.parse("2026-01-01") / 1000)}.000000`;
    const reset = await run([
      "slack",
      "cursor",
      "backfill",
      "--channel",
      "C1",
      "--since",
      "2026-01-01",
      "--yes",
    ]);
    expect(reset.code).toBe(0);
    expect(reset.out).toContain("backfilled");
    const status = await run(["slack", "status", "--json"]);
    expect(JSON.parse(status.out)).toEqual({ C1: floorTs });
  });

  test("cursor backfill warns when --since is not older than the current cursor (#57 footgun)", async () => {
    await run(["init"]);
    await seedCursor(JSON.stringify({ C1: "100.000000" })); // current is old
    // 2026-01-01 ts (~1.7e9) is newer than 100 → advancing, not backfilling.
    const { err } = await run([
      "slack",
      "cursor",
      "backfill",
      "--channel",
      "C1",
      "--since",
      "2026-01-01",
    ]);
    expect(err).toContain("not older than the current cursor");
  });

  test("cursor backfill requires --channel and --since", async () => {
    await run(["init"]);
    expect((await run(["slack", "cursor", "backfill", "--since", "30d"])).code).toBe(1);
    expect((await run(["slack", "cursor", "backfill", "--channel", "C1"])).code).toBe(1);
  });

  test("cursor backfill rejects an invalid --since", async () => {
    await run(["init"]);
    const { code, err } = await run([
      "slack",
      "cursor",
      "backfill",
      "--channel",
      "C1",
      "--since",
      "nonsense",
    ]);
    expect(code).toBe(1);
    expect(err).toContain("invalid --since");
  });
});

describe("suasor slack status / cursor — per-thread cursors (ADR-0015 R1, #418)", () => {
  test("status folds per-thread cursors into a per-channel active count", async () => {
    await run(["init"]);
    await seedCursor(
      JSON.stringify({
        C1: "111.000000",
        "C1#100.000000": "150.000000",
        "C1#200.000000": "250.000000",
      }),
    );
    const { code, out } = await run(["slack", "status"]);
    expect(code).toBe(0);
    // The channel row shows the count; the raw `<channel>#<thread_ts>` keys are
    // not printed as their own rows.
    expect(out).toContain("C1");
    expect(out).toContain("(+2 active threads)");
    expect(out).not.toContain("C1#100.000000");
  });

  test("status --json keeps the raw per-thread cursor keys", async () => {
    await run(["init"]);
    const cursor = { C1: "111.000000", "C1#100.000000": "150.000000" };
    await seedCursor(JSON.stringify(cursor));
    const { code, out } = await run(["slack", "status", "--json"]);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual(cursor);
  });

  test("cursor reset --channel --yes clears the channel's thread cursors too", async () => {
    await run(["init"]);
    await seedCursor(
      JSON.stringify({ C1: "111.000000", "C1#100.000000": "150.000000", C2: "222.000000" }),
    );
    const reset = await run(["slack", "cursor", "reset", "--channel", "C1", "--yes"]);
    expect(reset.code).toBe(0);
    expect(reset.out).toContain("(+1 thread)");
    const status = await run(["slack", "status", "--json"]);
    // C1 and its thread mark are gone; C2 (and any of its threads) untouched.
    expect(JSON.parse(status.out)).toEqual({ C2: "222.000000" });
  });

  test("cursor backfill --channel --yes clears the channel's thread cursors", async () => {
    await run(["init"]);
    await seedCursor(JSON.stringify({ C1: "999999999.000000", "C1#100.000000": "150.000000" }));
    const floorTs = `${Math.floor(Date.parse("2026-01-01") / 1000)}.000000`;
    const backfill = await run([
      "slack",
      "cursor",
      "backfill",
      "--channel",
      "C1",
      "--since",
      "2026-01-01",
      "--yes",
    ]);
    expect(backfill.code).toBe(0);
    expect(backfill.out).toContain("thread cursor(s) cleared");
    const status = await run(["slack", "status", "--json"]);
    expect(JSON.parse(status.out)).toEqual({ C1: floorTs });
  });
});
