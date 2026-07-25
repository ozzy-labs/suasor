/**
 * Sync freshness derivation (Issue #442).
 *
 * The point of these tests is that the verdict is a pure function of
 * (enabled connectors, run rows, now) — so `doctor`, `brief`, and the MCP
 * `sync.status` tool can never disagree about whether ingest is behind, and so
 * the wall-clock dependence stays pinned instead of drifting with the suite's
 * runtime (the same discipline ADR-0028 applies to `overdue`).
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_EXPECTED_INTERVAL_HOURS,
  DEFAULT_SAFETY_FACTOR,
  deriveSyncFreshness,
  type SyncRunLike,
  staleConnectors,
  summarizeStaleSync,
  syncFreshnessInputs,
} from "../../src/connectors/freshness.ts";

const NOW = "2026-07-25T12:00:00.000Z";

/** A completed run that ended `hours` before {@link NOW}. */
function run(connector: string, hours: number, status = "ok"): SyncRunLike {
  const endedAt = new Date(Date.parse(NOW) - hours * 60 * 60 * 1000).toISOString();
  return { connector, startedAt: endedAt, endedAt, status };
}

describe("deriveSyncFreshness", () => {
  test("a recent successful run is ok", () => {
    const [f] = deriveSyncFreshness(["slack"], [run("slack", 2)], { now: NOW });
    expect(f?.state).toBe("ok");
    expect(f?.ageHours).toBe(2);
    expect(f?.detail).toBe("last synced 2h ago");
  });

  test("past cadence × safety factor is stale, inside it is not", () => {
    const opts = { now: NOW, expectedIntervalHours: 6, safetyFactor: 2 };
    // Threshold is 12h: 12 is not yet past it, 13 is.
    expect(deriveSyncFreshness(["slack"], [run("slack", 12)], opts)[0]?.state).toBe("ok");
    const [stale] = deriveSyncFreshness(["slack"], [run("slack", 13)], opts);
    expect(stale?.state).toBe("stale");
    expect(stale?.thresholdHours).toBe(12);
    expect(stale?.detail).toContain("13h ago");
  });

  test("a connector with no run at all reads as never, not merely stale", () => {
    const [f] = deriveSyncFreshness(["github"], [], { now: NOW });
    expect(f?.state).toBe("never");
    expect(f?.lastSyncAt).toBeNull();
    expect(f?.ageHours).toBeNull();
    expect(f?.detail).toContain("never synced");
  });

  test("a first run still in flight has landed nothing yet", () => {
    const inFlight: SyncRunLike = {
      connector: "box",
      startedAt: NOW,
      endedAt: null,
      status: "running",
    };
    const [f] = deriveSyncFreshness(["box"], [inFlight], { now: NOW });
    expect(f?.state).toBe("never");
    expect(f?.detail).toContain("still in flight");
  });

  test("a failed run is failing regardless of how recent it is", () => {
    // Fresh (1h old) but errored: the data is not advancing, and the fix is a
    // credential / network one, not "schedule a sync".
    const [f] = deriveSyncFreshness(["google"], [run("google", 1, "error")], { now: NOW });
    expect(f?.state).toBe("failing");
    expect(f?.detail).toContain("last run failed");
  });

  test("per-connector overrides beat the global cadence", () => {
    const opts = {
      now: NOW,
      expectedIntervalHours: 1,
      safetyFactor: 1,
      perConnectorIntervalHours: { box: 168 },
    };
    const result = deriveSyncFreshness(
      ["box", "slack"],
      [run("box", 100), run("slack", 100)],
      opts,
    );
    expect(result.find((f) => f.connector === "box")?.state).toBe("ok");
    expect(result.find((f) => f.connector === "slack")?.state).toBe("stale");
  });

  test("only enabled connectors are judged — a run row for a disabled one is ignored", () => {
    // Turning a connector off should silence it; a warning surface that keeps
    // nagging about something the operator disabled stops being read at all.
    const result = deriveSyncFreshness(["slack"], [run("slack", 1), run("notion", 900)], {
      now: NOW,
    });
    expect(result.map((f) => f.connector)).toEqual(["slack"]);
  });

  test("results are sorted by connector for stable rendering", () => {
    const result = deriveSyncFreshness(["slack", "github", "box"], [], { now: NOW });
    expect(result.map((f) => f.connector)).toEqual(["box", "github", "slack"]);
  });

  test("defaults tolerate one missed run (24h cadence, 2× factor)", () => {
    expect(DEFAULT_EXPECTED_INTERVAL_HOURS * DEFAULT_SAFETY_FACTOR).toBe(48);
    expect(deriveSyncFreshness(["slack"], [run("slack", 47)], { now: NOW })[0]?.state).toBe("ok");
    expect(deriveSyncFreshness(["slack"], [run("slack", 49)], { now: NOW })[0]?.state).toBe(
      "stale",
    );
  });

  test("a clock that jumped backwards clamps to 0 rather than reporting negative age", () => {
    const future: SyncRunLike = {
      connector: "slack",
      startedAt: NOW,
      endedAt: "2026-07-26T12:00:00.000Z",
      status: "ok",
    };
    const [f] = deriveSyncFreshness(["slack"], [future], { now: NOW });
    expect(f?.ageHours).toBe(0);
    expect(f?.state).toBe("ok");
  });
});

describe("summarizeStaleSync", () => {
  test("returns null when everything is current", () => {
    expect(
      summarizeStaleSync(deriveSyncFreshness(["slack"], [run("slack", 1)], { now: NOW })),
    ).toBe(null);
  });

  test("names each behind connector with why it is behind", () => {
    const freshness = deriveSyncFreshness(
      ["github", "google", "slack"],
      [run("google", 1, "error"), run("slack", 200)],
      { now: NOW },
    );
    const summary = summarizeStaleSync(freshness);
    expect(summary).toContain("github (never synced)");
    expect(summary).toContain("google (last run failed)");
    expect(summary).toContain("slack (200h old)");
    expect(staleConnectors(freshness)).toHaveLength(3);
  });
});

describe("syncFreshnessInputs", () => {
  const sync = {
    expectedIntervalHours: 12,
    safetyFactor: 3,
    perConnectorIntervalHours: { box: 168 },
  };

  test("selects configured connectors, skipping explicitly disabled ones", () => {
    const inputs = syncFreshnessInputs(["slack", "github", "box"], {
      connectors: { slack: {}, github: { enabled: false } },
      sync,
    });
    expect(inputs.enabledConnectors).toEqual(["slack"]);
    expect(inputs.expectedIntervalHours).toBe(12);
    expect(inputs.safetyFactor).toBe(3);
    expect(inputs.perConnectorIntervalHours).toEqual({ box: 168 });
  });

  test("a connector absent from config is not judged", () => {
    const inputs = syncFreshnessInputs(["slack"], { connectors: {}, sync });
    expect(inputs.enabledConnectors).toEqual([]);
  });
});
