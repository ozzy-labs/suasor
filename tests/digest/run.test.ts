import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DigestJob } from "../../src/config/schema.ts";
import { Store } from "../../src/db/index.ts";
import { runDigest } from "../../src/digest/run.ts";

const NOW = "2026-06-20T00:00:00.000Z";

let store: Store;
let exportDir: string;

beforeEach(() => {
  store = Store.open({ path: ":memory:" });
  exportDir = mkdtempSync(join(tmpdir(), "suasor-digest-run-"));
});

afterEach(() => {
  store.close();
  rmSync(exportDir, { recursive: true, force: true });
});

function sqlite() {
  return store.connection.sqlite;
}

function task(taskId: string, title: string, dueDate?: string): void {
  store.record({
    type: "TaskProposed",
    taskId,
    title,
    ...(dueDate ? { dueDate } : {}),
    sourceExternalIds: [],
  });
  store.record({ type: "TaskApplied", taskId, state: "open" });
}

const fileJob = (name: string, over: Partial<DigestJob> = {}): DigestJob => ({
  name,
  channel: "file",
  limit: 10,
  ...over,
});

describe("runDigest", () => {
  test("no jobs → nothing produced (standing-consent boundary)", async () => {
    const results = await runDigest(sqlite(), [], { now: NOW, exportDir });
    expect(results).toEqual([]);
  });

  test("delivers a file job into the export sandbox (acceptance: one digest out)", async () => {
    task("t-overdue", "ship the release", "2026-06-10T00:00:00.000Z");
    const results = await runDigest(sqlite(), [fileJob("morning")], { now: NOW, exportDir });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ job: "morning", channel: "file", status: "delivered" });
    const path = join(exportDir, "morning.md");
    expect(results[0]?.detail).toBe(path);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("ship the release");
  });

  test("honours a custom filename", async () => {
    const results = await runDigest(sqlite(), [fileJob("m", { filename: "daily.txt" })], {
      now: NOW,
      exportDir,
    });
    expect(results[0]?.detail).toBe(join(exportDir, "daily.txt"));
    expect(existsSync(join(exportDir, "daily.txt"))).toBe(true);
  });

  test("--dry-run renders but does not write", async () => {
    task("t1", "do a thing");
    const results = await runDigest(sqlite(), [fileJob("morning")], {
      now: NOW,
      exportDir,
      dryRun: true,
    });
    expect(results[0]?.status).toBe("skipped");
    expect(results[0]?.digest.priorities.map((p) => p.id)).toEqual(["t1"]);
    expect(existsSync(join(exportDir, "morning.md"))).toBe(false);
  });

  test("jobName filters to a single job", async () => {
    const results = await runDigest(sqlite(), [fileJob("a"), fileJob("b")], {
      now: NOW,
      exportDir,
      jobName: "b",
    });
    expect(results.map((r) => r.job)).toEqual(["b"]);
  });

  test("one failing channel does not silence the others (per-job isolation)", async () => {
    task("t1", "a task");
    const slackJob: DigestJob = { name: "ping", channel: "slack-dm", limit: 10 };
    const results = await runDigest(sqlite(), [fileJob("morning"), slackJob], {
      now: NOW,
      exportDir,
      resolveSlackToken: async () => null, // no token in the keychain
      resolveSlackSelfId: () => "U_ME",
    });

    const byJob = Object.fromEntries(results.map((r) => [r.job, r]));
    expect(byJob.morning?.status).toBe("delivered");
    expect(byJob.ping?.status).toBe("failed");
    expect(byJob.ping?.errorCode).toBe("SLACK_TOKEN_NOT_CONFIGURED");
    // The healthy job still wrote its file.
    expect(existsSync(join(exportDir, "morning.md"))).toBe(true);
  });

  test("delivers a slack-dm job through the actuator path with injected transport", async () => {
    task("t1", "a task");
    const slackJob: DigestJob = { name: "dm", channel: "slack-dm", limit: 10 };
    const results = await runDigest(sqlite(), [slackJob], {
      now: NOW,
      exportDir,
      resolveSlackToken: async () => "xoxb-token",
      resolveSlackSelfId: () => "U_ME",
      deliveryDeps: {
        slackDm: {
          slackFetch: async (url) => ({
            status: 200,
            headers: new Headers(),
            body: url.includes("conversations.open")
              ? { ok: true, channel: { id: "D1" } }
              : { ok: true },
          }),
        },
      },
    });
    expect(results[0]).toMatchObject({ job: "dm", status: "delivered", detail: "dm:D1" });
  });
});
