import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../../src/db/index.ts";
import {
  buildDigest,
  isDigestEmpty,
  renderDigestNotification,
  renderDigestText,
} from "../../src/digest/content.ts";
import type { BriefWarning } from "../../src/mcp/queries.ts";

// A fixed 'now' pins overdue / freshness so the digest is reproducible.
const NOW = "2026-06-20T00:00:00.000Z";

let store: Store;

beforeEach(() => {
  store = Store.open({ path: ":memory:" });
});

afterEach(() => {
  store.close();
});

function sqlite() {
  return store.connection.sqlite;
}

/** Seed an open task with an optional dueDate / priority. */
function task(
  taskId: string,
  title: string,
  opts: { dueDate?: string; priority?: "low" | "normal" | "high" } = {},
): void {
  store.record({
    type: "TaskProposed",
    taskId,
    title,
    ...(opts.dueDate ? { dueDate: opts.dueDate } : {}),
    ...(opts.priority ? { priority: opts.priority } : {}),
    sourceExternalIds: [],
  });
  store.record({ type: "TaskApplied", taskId, state: "open" });
}

/** Seed an open commitment with an optional dueDate. */
function commitment(commitmentId: string, title: string, dueDate?: string): void {
  store.record({
    type: "CommitmentOpened",
    commitmentId,
    title,
    direction: "owed_by_me",
    ...(dueDate ? { dueDate } : {}),
    sourceExternalIds: [],
  });
}

/** Seed a slack DM demand row observed at `observedAt`. */
function demand(externalId: string, observedAt: string): void {
  store.record({
    type: "SourceObserved",
    externalId,
    sourceType: "slack_message",
    body: `please review ${externalId}`,
    observedAt,
    fingerprint: externalId,
    meta: { team: "T1", channel: "D9" },
  });
}

const SLACK_WARNING: BriefWarning = {
  key: "slack_not_configured",
  message: "Slack connector not configured — demand (@mention / DM) is always empty",
};

describe("buildDigest — content composition (ADR-0040 §4)", () => {
  test("composes the scorer top-N (overdue > demand > due-soon) plus warnings", () => {
    commitment("c-overdue", "renew the cert", "2026-06-05T00:00:00.000Z"); // overdue
    task("t-overdue", "ship the release", { dueDate: "2026-06-10T00:00:00.000Z" }); // overdue
    demand("dm1", "2026-06-19T00:00:00.000Z"); // un-acked demand
    task("t-soon", "pay invoice", { dueDate: "2026-06-25T00:00:00.000Z" }); // due_soon

    const digest = buildDigest(sqlite(), { now: NOW, warnings: [SLACK_WARNING] });

    expect(digest.generatedAt).toBe(NOW);
    expect(digest.priorities.map((p) => p.id)).toEqual(["c-overdue", "t-overdue", "dm1", "t-soon"]);
    expect(digest.priorities.map((p) => p.reason)).toEqual([
      "overdue",
      "overdue",
      "unacked_demand",
      "due_soon",
    ]);
    // The brief warnings pass through verbatim (#189).
    expect(digest.warnings).toEqual([SLACK_WARNING]);
    expect(digest.truncated).toBe(false);
  });

  test("honours the top-N limit and reports truncation", () => {
    task("t1", "one", { dueDate: "2026-06-25T00:00:00.000Z" });
    task("t2", "two", { dueDate: "2026-06-26T00:00:00.000Z" });
    task("t3", "three", { dueDate: "2026-06-27T00:00:00.000Z" });

    const digest = buildDigest(sqlite(), { now: NOW, limit: 2 });
    expect(digest.priorities).toHaveLength(2);
    expect(digest.truncated).toBe(true);
  });

  test("threads selfUserIds through so @mentions become demand", () => {
    store.record({
      type: "SourceObserved",
      externalId: "m1",
      sourceType: "slack_message",
      body: "hey <@U_ME> can you review",
      observedAt: "2026-06-19T00:00:00.000Z",
      fingerprint: "m1",
      meta: { team: "T1", channel: "C1", ts: "m1" },
    });
    // Without the self id, the mention is not a demand signal.
    expect(buildDigest(sqlite(), { now: NOW }).priorities).toHaveLength(0);
    // With it, the mention surfaces as an un-acked demand row.
    const withSelf = buildDigest(sqlite(), { now: NOW, selfUserIds: ["U_ME"] });
    expect(withSelf.priorities.map((p) => p.id)).toEqual(["m1"]);
    expect(withSelf.priorities[0]?.reason).toBe("unacked_demand");
  });

  test("is empty when there is nothing to surface", () => {
    const digest = buildDigest(sqlite(), { now: NOW });
    expect(digest.priorities).toEqual([]);
    expect(isDigestEmpty(digest)).toBe(true);
  });
});

describe("renderDigestText", () => {
  test("renders each row with its scorer reason and the warnings block", () => {
    task("t-overdue", "ship the release", { dueDate: "2026-06-10T00:00:00.000Z" });
    const digest = buildDigest(sqlite(), { now: NOW, warnings: [SLACK_WARNING] });
    const text = renderDigestText(digest, { title: "morning" });

    expect(text).toContain("Suasor digest — morning");
    expect(text).toContain("Priorities (1):");
    expect(text).toContain("1. [overdue] ship the release");
    expect(text).toContain("Warnings:");
    expect(text).toContain("⚠ slack_not_configured:");
  });

  test("shows 'Priorities: none' when empty", () => {
    const text = renderDigestText(buildDigest(sqlite(), { now: NOW }));
    expect(text).toContain("Priorities: none");
    expect(text).not.toContain("Warnings:");
  });
});

describe("renderDigestNotification", () => {
  test("compacts to a count + top row", () => {
    task("t-overdue", "ship the release", { dueDate: "2026-06-10T00:00:00.000Z" });
    task("t-soon", "pay invoice", { dueDate: "2026-06-25T00:00:00.000Z" });
    const n = renderDigestNotification(buildDigest(sqlite(), { now: NOW }), { title: "morning" });
    expect(n.title).toBe("Suasor digest — morning");
    expect(n.body).toContain("2 priorities");
    expect(n.body).toContain("top: ship the release");
  });

  test("degrades to a quiet body when empty", () => {
    const n = renderDigestNotification(buildDigest(sqlite(), { now: NOW }));
    expect(n.body).toBe("Nothing needs your attention right now.");
  });
});
