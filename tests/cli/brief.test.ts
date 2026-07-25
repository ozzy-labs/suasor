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

/** Record a completed sync run for `connector`, ended at `endedAt` (Issue #442). */
async function recordSyncRun(connector: string, endedAt: string): Promise<void> {
  const { Store } = await import("../../src/db/index.ts");
  const store = Store.open({ path: join(dir, "suasor.db") });
  const startedAt = new Date(new Date(endedAt).getTime() - 1000).toISOString();
  store.record(
    { type: "SyncRunStarted", runId: `${connector}:${startedAt}`, connector, startedAt },
    new Date(startedAt),
  );
  // The projection stores the *event's* recordedAt as `ended_at` (ADR-0033), so
  // back-dating a run means injecting the store clock, not a payload field.
  store.record(
    {
      type: "SyncRunEnded",
      runId: `${connector}:${startedAt}`,
      connector,
      status: "ok",
      observed: 0,
      updated: 0,
      unchanged: 0,
      durationMs: 1000,
    },
    new Date(endedAt),
  );
  store.close();
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

  /** Seed `n` in-window sources so a small `--limit` truncates the section. */
  async function seedSources(n: number): Promise<void> {
    const { Store } = await import("../../src/db/index.ts");
    const store = Store.open({ path: join(dir, "suasor.db") });
    for (let i = 0; i < n; i++) {
      store.record({
        type: "SourceObserved",
        externalId: `s:${i}`,
        sourceType: "github_issue",
        body: `body ${i}`,
        observedAt: `2026-06-14T00:00:0${i}.000Z`,
        fingerprint: `s:${i}`,
        meta: {},
      });
    }
    store.close();
  }

  test("flags a section the --limit cut off in the human output (Issue #444)", async () => {
    await seedSources(3);
    const { code, out } = await run(["brief", "--since", "2020-01-01", "--limit", "2"]);
    expect(code).toBe(0);
    expect(out).toContain("[⚠ truncated: sources]");
  });

  test("no truncation note when every section fits under --limit (Issue #444)", async () => {
    await seedSources(2);
    const { code, out } = await run(["brief", "--since", "2020-01-01", "--limit", "2"]);
    expect(code).toBe(0);
    expect(out).not.toContain("truncated");
  });

  test("--json carries the per-section truncated flags (Issue #444)", async () => {
    await seedSources(3);
    const { code, out } = await run(["brief", "--since", "2020-01-01", "--limit", "2", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.truncated).toEqual({
      sources: true,
      tasks: false,
      decisions: false,
      inbox: false,
      demand: false,
    });
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

  test("hints on stderr when the embedding backend is disabled (Issue #159)", async () => {
    await seed();
    const { code, out, err } = await run(["brief", "--since", "2020-01-01"]);
    expect(code).toBe(0);
    expect(err).toContain("embedding disabled");
    expect(err).toContain("docs/guide/embedding.md");
    // stdout (the brief summary) must stay clean of the hint.
    expect(out).not.toContain("embedding disabled");
  });

  test("emits no hint when the embedding backend is enabled (Issue #159)", async () => {
    await Bun.write(join(dir, "config.toml"), '[embedding]\nbackend = "ollama"\n');
    await seed();
    const { code, err } = await run(["brief", "--since", "2020-01-01"]);
    expect(code).toBe(0);
    expect(err).not.toContain("embedding disabled");
  });

  test("--json suppresses the hint so the piped bundle stays clean (Issue #159)", async () => {
    await seed();
    const { code, out, err } = await run(["brief", "--since", "2020-01-01", "--json"]);
    expect(code).toBe(0);
    expect(err).not.toContain("embedding disabled");
    expect(out).not.toContain("embedding disabled");
    expect(JSON.parse(out).tasks).toHaveLength(1);
  });

  test("annotates the header with completeness warnings (Issue #189)", async () => {
    await seed();
    // Default config: no [connectors.slack] + embedding disabled → both signals.
    const { code, out } = await run(["brief", "--since", "2020-01-01"]);
    expect(code).toBe(0);
    expect(out).toContain("[⚠ slack_not_configured, embedding_disabled, commitment_scan_stale]");
  });

  test("--json includes the warnings array with stable keys (Issue #189)", async () => {
    await seed();
    const { code, out } = await run(["brief", "--since", "2020-01-01", "--json"]);
    expect(code).toBe(0);
    const keys = JSON.parse(out).warnings.map((w: { key: string }) => w.key);
    expect(keys).toEqual(["slack_not_configured", "embedding_disabled", "commitment_scan_stale"]);
  });

  test("drops embedding_disabled once a backend is enabled (Issue #189)", async () => {
    await Bun.write(join(dir, "config.toml"), '[embedding]\nbackend = "ollama"\n');
    await seed();
    const { code, out } = await run(["brief", "--since", "2020-01-01", "--json"]);
    expect(code).toBe(0);
    const keys = JSON.parse(out).warnings.map((w: { key: string }) => w.key);
    expect(keys).toEqual(["slack_not_configured", "commitment_scan_stale"]);
  });

  test("a configured connector that has never synced warns sync_stale (Issue #442)", async () => {
    await Bun.write(
      join(dir, "config.toml"),
      '[embedding]\nbackend = "ollama"\n\n[connectors.slack]\nself_user_ids = ["U1"]\n',
    );
    await seed();
    const { code, out } = await run(["brief", "--since", "2020-01-01", "--json"]);
    expect(code).toBe(0);
    const warnings = JSON.parse(out).warnings as Array<{ key: string; message: string }>;
    // Slack is wired but nothing has ever landed — an empty bundle here is a
    // stopped pipeline, not a quiet day, and the brief now says so.
    expect(warnings.map((w) => w.key)).toEqual(["sync_stale", "commitment_scan_stale"]);
    expect(warnings[0]?.message).toContain("slack (never synced)");
  });

  test("emits no warnings when everything is configured and freshly synced (#189/#442)", async () => {
    await Bun.write(
      join(dir, "config.toml"),
      '[embedding]\nbackend = "ollama"\n\n[connectors.slack]\nself_user_ids = ["U1"]\n',
    );
    await seed();
    await recordSyncRun("slack", new Date().toISOString());
    const { code, out } = await run(["brief", "--since", "2020-01-01", "--json"]);
    expect(code).toBe(0);
    // Only the never-scanned commitment ledger remains (the seeded source has
    // never been checked for promises) — sync and config are both clean.
    const keys = (JSON.parse(out).warnings as Array<{ key: string }>).map((w) => w.key);
    expect(keys).toEqual(["commitment_scan_stale"]);
  });

  test("a sync older than the cadence threshold warns with its age (Issue #442)", async () => {
    await Bun.write(
      join(dir, "config.toml"),
      '[embedding]\nbackend = "ollama"\n\n[connectors.slack]\nself_user_ids = ["U1"]\n' +
        "\n[sync]\nexpectedIntervalHours = 1\nsafetyFactor = 2\n",
    );
    await seed();
    // 5h ago, against a 1h × 2 threshold.
    await recordSyncRun("slack", new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString());
    const { code, out } = await run(["brief", "--since", "2020-01-01", "--json"]);
    expect(code).toBe(0);
    const warnings = JSON.parse(out).warnings as Array<{ key: string; message: string }>;
    expect(warnings.map((w) => w.key)).toEqual(["sync_stale", "commitment_scan_stale"]);
    expect(warnings[0]?.message).toMatch(/slack \(5h old\)/);
  });
});
