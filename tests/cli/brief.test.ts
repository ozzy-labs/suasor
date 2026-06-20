import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSince } from "../../src/cli/commands/brief.ts";
import { buildCli } from "../../src/cli/index.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "suasor-cli-brief-"));
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

/** Seed a source + task + decision in the db the CLI will open. */
async function seed(): Promise<void> {
  const { Store } = await import("../../src/db/index.ts");
  const store = Store.open({ path: join(dir, "suasor.db") });
  store.record({
    type: "SourceObserved",
    externalId: "gh:1",
    sourceType: "github_issue",
    body: "deploy the rocket",
    observedAt: "2026-06-14T00:00:00.000Z",
    fingerprint: "gh:1",
    meta: {},
  });
  store.record({
    type: "TaskProposed",
    taskId: "t1",
    title: "ship it",
    sourceExternalIds: ["gh:1"],
  });
  store.record({
    type: "DecisionRecorded",
    decisionId: "d1",
    title: "use bun",
    sourceExternalIds: [],
  });
  store.close();
}

describe("resolveSince", () => {
  const now = Date.parse("2026-06-20T12:00:00.000Z");

  test("parses relative durations (h / d / w)", () => {
    expect(resolveSince("24h", now)).toBe("2026-06-19T12:00:00.000Z");
    expect(resolveSince("7d", now)).toBe("2026-06-13T12:00:00.000Z");
    expect(resolveSince("2w", now)).toBe("2026-06-06T12:00:00.000Z");
  });

  test("parses an absolute ISO date", () => {
    expect(resolveSince("2026-06-01", now)).toBe("2026-06-01T00:00:00.000Z");
  });

  test("returns null for an unparseable value", () => {
    expect(resolveSince("yesterday", now)).toBeNull();
    expect(resolveSince("5x", now)).toBeNull();
  });
});

describe("suasor brief", () => {
  test("prints a human-readable summary with per-section counts", async () => {
    await seed();
    const { code, out } = await run(["brief", "--since", "2020-01-01"]);
    expect(code).toBe(0);
    expect(out).toContain("tasks: 1");
    expect(out).toContain("decisions: 1");
    expect(out).toContain("[task:proposed] ship it");
    expect(out).toContain("[decision] use bun");
  });

  test("--json emits the full bundle with the window", async () => {
    await seed();
    const { code, out } = await run(["brief", "--since", "2020-01-01", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.window.since).toBe("2020-01-01T00:00:00.000Z");
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.decisions[0].title).toBe("use bun");
  });

  test("rejects an invalid --since", async () => {
    const { code, err } = await run(["brief", "--since", "lastweek"]);
    expect(code).toBe(1);
    expect(err).toContain("--since must be");
  });

  test("rejects an invalid --until", async () => {
    const { code, err } = await run(["brief", "--until", "soon"]);
    expect(code).toBe(1);
    expect(err).toContain("--until must be");
  });

  test("rejects a non-positive --limit", async () => {
    const { code, err } = await run(["brief", "--limit", "0"]);
    expect(code).toBe(1);
    expect(err).toContain("--limit must be a positive integer");
  });
});
