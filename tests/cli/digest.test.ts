import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCli } from "../../src/cli/index.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "suasor-cli-digest-"));
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

/** Seed an open, overdue task in the db the CLI will open. */
async function seed(): Promise<void> {
  const { Store } = await import("../../src/db/index.ts");
  const store = Store.open({ path: join(dir, "suasor.db") });
  store.record({
    type: "TaskProposed",
    taskId: "t1",
    title: "ship the release",
    dueDate: "2020-01-01T00:00:00.000Z", // long overdue
    sourceExternalIds: [],
  });
  store.record({ type: "TaskApplied", taskId: "t1", state: "open" });
  store.close();
}

const FILE_JOB_CONFIG = '[[digest.jobs]]\nname = "morning"\nchannel = "file"\n';

describe("suasor digest", () => {
  test("delivers one digest to a configured file channel (acceptance)", async () => {
    await Bun.write(join(dir, "config.toml"), FILE_JOB_CONFIG);
    await seed();

    const { code, out } = await run(["digest"]);
    expect(code).toBe(0);
    expect(out).toContain("morning");
    expect(out).toContain("delivered");

    const path = join(dir, "exports", "morning.md");
    expect(existsSync(path)).toBe(true);
    const body = readFileSync(path, "utf8");
    expect(body).toContain("Suasor digest — morning");
    expect(body).toContain("[overdue] ship the release");
  });

  test("sends nothing when no job is configured (未構成では何も送られない)", async () => {
    await seed();
    const { code, out, err } = await run(["digest"]);
    expect(code).toBe(0);
    expect(err).toContain("no digest jobs configured");
    // stdout stays silent and no channel wrote anything.
    expect(out).toBe("");
    expect(existsSync(join(dir, "exports"))).toBe(false);
  });

  test("--json emits the delivery results (empty when unconfigured)", async () => {
    await seed();
    const { code, out } = await run(["digest", "--json"]);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ results: [] });
  });

  test("--json includes per-job delivery status when configured", async () => {
    await Bun.write(join(dir, "config.toml"), FILE_JOB_CONFIG);
    await seed();
    const { code, out } = await run(["digest", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].job).toBe("morning");
    expect(parsed.results[0].status).toBe("delivered");
    expect(parsed.results[0].digest.priorities[0].id).toBe("t1");
  });

  test("--dry-run renders to stdout without delivering", async () => {
    await Bun.write(join(dir, "config.toml"), FILE_JOB_CONFIG);
    await seed();
    const { code, out } = await run(["digest", "--dry-run"]);
    expect(code).toBe(0);
    expect(out).toContain("dry-run");
    expect(out).toContain("[overdue] ship the release");
    // Dry-run must not write the channel file.
    expect(existsSync(join(dir, "exports", "morning.md"))).toBe(false);
  });

  test("errors on an unknown --job name", async () => {
    await Bun.write(join(dir, "config.toml"), FILE_JOB_CONFIG);
    await seed();
    const { code, err } = await run(["digest", "--job", "evening"]);
    expect(code).toBe(1);
    expect(err).toContain("no digest job named 'evening'");
  });
});
