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

describe("suasor slack status / cursor reset (ADR-0016)", () => {
  test("status reports no cursor on a fresh store", async () => {
    await run(["init"]);
    const { code, out } = await run(["slack", "status"]);
    expect(code).toBe(0);
    expect(out).toContain("(none");
  });

  test("status prints the per-workspace / channel cursor", async () => {
    await run(["init"]);
    await seedCursor(JSON.stringify({ default: { C1: "111.000000", C2: "222.000000" } }));
    const { code, out } = await run(["slack", "status"]);
    expect(code).toBe(0);
    expect(out).toContain("[default]");
    expect(out).toContain("C1  111.000000");
    expect(out).toContain("C2  222.000000");
  });

  test("status --json emits the cursor map", async () => {
    await run(["init"]);
    await seedCursor(JSON.stringify({ default: { C1: "111.000000" } }));
    const { code, out } = await run(["slack", "status", "--json"]);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ default: { C1: "111.000000" } });
  });

  test("cursor reset without --yes previews and does not mutate", async () => {
    await run(["init"]);
    await seedCursor(JSON.stringify({ default: { C1: "111.000000", C2: "222.000000" } }));
    const preview = await run(["slack", "cursor", "reset", "--channel", "C1"]);
    expect(preview.code).toBe(0);
    expect(preview.out).toContain("would reset");
    expect(preview.out).toContain("[default] C1");
    // Unchanged: C1 still present.
    const status = await run(["slack", "status", "--json"]);
    expect(JSON.parse(status.out)).toEqual({ default: { C1: "111.000000", C2: "222.000000" } });
  });

  test("cursor reset --yes removes the channel; others remain", async () => {
    await run(["init"]);
    await seedCursor(JSON.stringify({ default: { C1: "111.000000", C2: "222.000000" } }));
    const reset = await run(["slack", "cursor", "reset", "--channel", "C1", "--yes"]);
    expect(reset.code).toBe(0);
    expect(reset.out).toContain("reset:");
    const status = await run(["slack", "status", "--json"]);
    expect(JSON.parse(status.out)).toEqual({ default: { C2: "222.000000" } });
  });

  test("cursor reset --all --yes clears everything", async () => {
    await run(["init"]);
    await seedCursor(JSON.stringify({ default: { C1: "111.000000" }, acme: { C9: "9.000000" } }));
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
    await seedCursor(JSON.stringify({ default: { C1: "999999999.000000" } }));
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
    expect(JSON.parse(status.out)).toEqual({ default: { C1: "999999999.000000" } });
  });

  test("cursor backfill --yes lowers the channel cursor to the floor (#57)", async () => {
    await run(["init"]);
    await seedCursor(JSON.stringify({ default: { C1: "999999999.000000" } }));
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
    expect(JSON.parse(status.out)).toEqual({ default: { C1: floorTs } });
  });

  test("cursor backfill warns when --since is not older than the current cursor (#57 footgun)", async () => {
    await run(["init"]);
    await seedCursor(JSON.stringify({ default: { C1: "100.000000" } })); // current is old
    // 2026-01-01 ts (~1.7e9) is newer than 100 → advancing, not backfilling.
    const { err } = await run(["slack", "cursor", "backfill", "--channel", "C1", "--since", "2026-01-01"]);
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
