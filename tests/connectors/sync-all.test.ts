/**
 * Bulk sync orchestration service (ADR-0027, FR-ING-5/6).
 *
 * Exercises `selectEnabledConnectors` (enabled-set rule) and `runBulkSync`
 * (series run, continue-on-error, aggregate counts) with fake connectors against
 * a real on-disk-equivalent in-memory store — no network, no SDK.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Connector, SourceRecord, SyncResult } from "../../src/connectors/contract.ts";
import {
  CONCURRENCY_WARN_THRESHOLD,
  DEFAULT_CONCURRENCY,
  resolveConcurrency,
  runBulkSync,
  selectEnabledConnectors,
} from "../../src/connectors/sync-all.ts";
import { Store } from "../../src/db/index.ts";

let store: Store;

beforeEach(() => {
  store = Store.open({ path: ":memory:" });
});

afterEach(() => {
  store.close();
});

/** A fake connector emitting a fixed set of records under a given name. */
function fakeConnector(name: string, records: SourceRecord[]): Connector {
  return {
    name,
    sourceType: name,
    async *sync(): AsyncIterable<SourceRecord> {
      for (const r of records) yield r;
    },
    finalize(): SyncResult {
      return { cursor: null };
    },
  };
}

const rec = (id: string, body: string): SourceRecord => ({
  externalId: id,
  sourceType: "github_issue",
  body,
  observedAt: "2026-06-14T00:00:00.000Z",
  meta: {},
});

function sourceCount(): number {
  const row = store.connection.sqlite
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sources")
    .get();
  return row?.n ?? 0;
}

describe("selectEnabledConnectors", () => {
  const registered = ["box", "github", "slack", "web"];

  test("includes connectors with a slice that is not enabled = false", () => {
    const enabled = selectEnabledConnectors(registered, {
      github: { repos: [] },
      slack: { enabled: true },
    });
    expect(enabled).toEqual(["github", "slack"]);
  });

  test("excludes connectors with enabled = false and absent slices", () => {
    const enabled = selectEnabledConnectors(registered, {
      github: { enabled: false },
      web: {},
    });
    expect(enabled).toEqual(["web"]);
  });

  test("preserves the registry order passed in", () => {
    const enabled = selectEnabledConnectors(registered, {
      slack: {},
      box: {},
      github: {},
    });
    expect(enabled).toEqual(["box", "github", "slack"]);
  });

  test("empty when no slice is enabled", () => {
    expect(selectEnabledConnectors(registered, {})).toEqual([]);
  });
});

describe("runBulkSync", () => {
  test("runs every named connector in series and aggregates outcomes", async () => {
    const connectors: Record<string, Connector> = {
      a: fakeConnector("a", [rec("a:1", "alpha")]),
      b: fakeConnector("b", [rec("b:1", "beta"), rec("b:2", "gamma")]),
    };
    const result = await runBulkSync(store, {
      names: ["a", "b"],
      connectors: { a: {}, b: {} },
      loadConnector: async (name) => connectors[name] as Connector,
    });

    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.results.map((r) => r.connector)).toEqual(["a", "b"]);
    expect(result.results[0]?.outcome?.observed).toBe(1);
    expect(result.results[1]?.outcome?.observed).toBe(2);
    expect(sourceCount()).toBe(3);
  });

  test("continue-on-error: a failing connector does not stop the rest", async () => {
    const errors: string[] = [];
    const result = await runBulkSync(store, {
      names: ["good", "bad", "good2"],
      connectors: { good: {}, bad: {}, good2: {} },
      loadConnector: async (name) => {
        if (name === "bad") throw new Error("boom: no token");
        return fakeConnector(name, [rec(`${name}:1`, "body")]);
      },
      onConnectorError: (connector, error) => errors.push(`${connector}: ${error.message}`),
    });

    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(1);
    const bad = result.results.find((r) => r.connector === "bad");
    expect(bad?.ok).toBe(false);
    expect(bad?.error).toContain("boom: no token");
    // The two good connectors still ingested.
    expect(sourceCount()).toBe(2);
    expect(errors).toEqual(["bad: boom: no token"]);
  });

  test("partial failure marks the entry failed but keeps the outcome (ADR-0014, #166)", async () => {
    // A connector that collects a record but reports an internal partial failure
    // (e.g. one Slack workspace failed): the outcome is real, but the run must
    // count it failed so `suasor sync` exits 1 (ADR-0027 exit-code parity).
    const partialConnector: Connector = {
      name: "slack",
      sourceType: "slack",
      async *sync(): AsyncIterable<SourceRecord> {
        yield rec("slack:1", "from the ok workspace");
      },
      finalize(): SyncResult {
        return {
          cursor: null,
          partialFailure: true,
          summaryLines: ["workspaces: acme=ok, beta=failed (cursor preserved)"],
        };
      },
    };
    const errors: string[] = [];
    const result = await runBulkSync(store, {
      names: ["slack", "good"],
      connectors: { slack: {}, good: {} },
      loadConnector: async (name) =>
        name === "slack" ? partialConnector : fakeConnector(name, [rec("good:1", "b")]),
      onConnectorError: (connector, error) => errors.push(`${connector}: ${error.message}`),
    });

    expect(result.succeeded).toBe(1); // good
    expect(result.failed).toBe(1); // slack (partial)
    const slack = result.results.find((r) => r.connector === "slack");
    expect(slack?.ok).toBe(false);
    expect(slack?.outcome?.observed).toBe(1); // record was kept
    expect(slack?.outcome?.partialFailure).toBe(true);
    expect(slack?.error).toContain("partial failure");
    expect(slack?.error).toContain("beta=failed");
    expect(errors[0]).toContain("partial failure");
    // Both the ok-workspace record and the good connector's record persisted.
    expect(sourceCount()).toBe(2);
  });

  test("fail-fast (continueOnError: false) stops at the first failure", async () => {
    const ran: string[] = [];
    const result = await runBulkSync(store, {
      names: ["good", "bad", "after"],
      connectors: { good: {}, bad: {}, after: {} },
      continueOnError: false,
      loadConnector: async (name) => {
        ran.push(name);
        if (name === "bad") throw new Error("boom");
        return fakeConnector(name, [rec(`${name}:1`, "body")]);
      },
    });

    // "after" never ran; it is absent from results (not marked failed).
    expect(ran).toEqual(["good", "bad"]);
    expect(result.results.map((r) => r.connector)).toEqual(["good", "bad"]);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(sourceCount()).toBe(1);
  });

  test("idempotent: re-running the same data appends no duplicate events", async () => {
    const opts = {
      names: ["a"],
      connectors: { a: {} },
      loadConnector: async () => fakeConnector("a", [rec("a:1", "stable")]),
    };
    await runBulkSync(store, opts);
    const before = store.connection.sqlite
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE type = 'SourceObserved'")
      .get();
    const second = await runBulkSync(store, opts);
    const after = store.connection.sqlite
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE type = 'SourceObserved'")
      .get();

    expect(second.results[0]?.outcome?.unchanged).toBe(1);
    expect(second.results[0]?.outcome?.observed).toBe(0);
    expect(after?.n).toBe(before?.n); // no duplicate SourceObserved
    expect(sourceCount()).toBe(1);
  });

  test("onConnectorStart fires once per connector before its pass", async () => {
    const started: string[] = [];
    await runBulkSync(store, {
      names: ["a", "b"],
      connectors: { a: {}, b: {} },
      loadConnector: async (name) => fakeConnector(name, []),
      onConnectorStart: (name) => started.push(name),
    });
    expect(started).toEqual(["a", "b"]);
  });

  test("emits a no-op advisory via onWarn for empty connector slices (#187)", async () => {
    // Real connector names so the no-op detectors apply: github with no repos +
    // notifications off, web with no urls → both warn before sync. The run still
    // succeeds (fakeConnector yields nothing); the warning is the only signal.
    const warnings: string[] = [];
    const result = await runBulkSync(store, {
      names: ["github", "web"],
      connectors: { github: { repos: [] }, web: { urls: [] } },
      loadConnector: async (name) => fakeConnector(name, []),
      syncOptions: { onWarn: (m) => warnings.push(m) },
    });
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);
    expect(warnings.some((w) => w.startsWith("github:") && w.includes("取り込み対象なし"))).toBe(
      true,
    );
    expect(warnings.some((w) => w.startsWith("web:") && w.includes("取り込み対象なし"))).toBe(true);
  });

  test("does not warn for a connector slice with an ingest target (#187)", async () => {
    const warnings: string[] = [];
    await runBulkSync(store, {
      names: ["github", "web"],
      connectors: { github: { repos: ["owner/repo"] }, web: { urls: ["https://example.com"] } },
      loadConnector: async (name) => fakeConnector(name, []),
      syncOptions: { onWarn: (m) => warnings.push(m) },
    });
    expect(warnings).toEqual([]);
  });
});

describe("resolveConcurrency", () => {
  test("defaults to DEFAULT_CONCURRENCY, capped at the connector count", () => {
    expect(resolveConcurrency(10, undefined)).toBe(DEFAULT_CONCURRENCY);
    expect(resolveConcurrency(2, undefined)).toBe(2); // fewer connectors than the default
    expect(resolveConcurrency(0, undefined)).toBe(1); // never below 1
  });

  test("honours an explicit value, clamped to [1, count]", () => {
    expect(resolveConcurrency(10, 2)).toBe(2);
    expect(resolveConcurrency(3, 10)).toBe(3); // can't exceed the connector count
    expect(resolveConcurrency(5, 0)).toBe(1); // non-positive → serial
    expect(resolveConcurrency(5, -3)).toBe(1);
  });

  test("warns (but does not cap) above the threshold", () => {
    const warnings: string[] = [];
    // 12 connectors so the request itself is the binding limit, not the count.
    const resolved = resolveConcurrency(12, CONCURRENCY_WARN_THRESHOLD + 1, (m) =>
      warnings.push(m),
    );
    expect(resolved).toBe(CONCURRENCY_WARN_THRESHOLD + 1); // not capped
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("exceeds the recommended max");
  });

  test("does not warn at or below the threshold", () => {
    const warnings: string[] = [];
    resolveConcurrency(20, CONCURRENCY_WARN_THRESHOLD, (m) => warnings.push(m));
    expect(warnings).toEqual([]);
  });
});

/**
 * A connector whose `sync` blocks on an externally-resolved gate so a test can
 * observe how many connectors are mid-sync at once (the bounded-pool invariant).
 * `tracker` records concurrency and signals `onEnter` each time a connector
 * actually starts; `release()` lets all gated connectors finish. The `onEnter`
 * signal lets a test await pool saturation deterministically (no wall-clock sleep).
 */
function gatedConnector(
  name: string,
  tracker: { inflight: number; max: number; onEnter: () => void },
  gate: Promise<void>,
): Connector {
  return {
    name,
    sourceType: name,
    async *sync(): AsyncIterable<SourceRecord> {
      tracker.inflight += 1;
      tracker.max = Math.max(tracker.max, tracker.inflight);
      tracker.onEnter();
      try {
        await gate;
      } finally {
        tracker.inflight -= 1;
      }
      yield rec(`${name}:1`, "body");
    },
    finalize(): SyncResult {
      return { cursor: null };
    },
  };
}

/** A latch that resolves once `count` signals have arrived (a counting barrier). */
function barrier(count: number): { signal: () => void; reached: Promise<void> } {
  let seen = 0;
  let resolve!: () => void;
  const reached = new Promise<void>((r) => {
    resolve = r;
  });
  return {
    signal: () => {
      seen += 1;
      if (seen >= count) resolve();
    },
    reached,
  };
}

describe("runBulkSync — bounded concurrency (Issue #269)", () => {
  test("never runs more than `concurrency` connectors at once", async () => {
    // Deterministic (no sleep): wait until exactly `poolSize` connectors have
    // entered, assert the pool is saturated but not over, then release the gate.
    const poolSize = 2;
    const entered = barrier(poolSize);
    const tracker = { inflight: 0, max: 0, onEnter: () => entered.signal() };
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const names = ["a", "b", "c", "d", "e"];

    const run = runBulkSync(store, {
      names,
      connectors: Object.fromEntries(names.map((n) => [n, {}])),
      concurrency: poolSize,
      loadConnector: async (name) => gatedConnector(name, tracker, gate),
    });
    // Block until the first `poolSize` connectors are gated (pool saturated).
    await entered.reached;
    expect(tracker.inflight).toBe(poolSize); // saturated
    expect(tracker.max).toBe(poolSize); // and never exceeded the bound
    release();
    const result = await run;

    expect(result.succeeded).toBe(5);
    expect(result.failed).toBe(0);
    expect(tracker.max).toBe(poolSize); // bound held for the whole run
    expect(result.results.map((r) => r.connector)).toEqual(names); // names order
  });

  test("aggregates in `names` order regardless of finish order", async () => {
    // "slow" finishes last but must still appear in its names position.
    const names = ["slow", "fast1", "fast2"];
    const result = await runBulkSync(store, {
      names,
      connectors: Object.fromEntries(names.map((n) => [n, {}])),
      concurrency: 3,
      loadConnector: async (name) => {
        if (name === "slow") {
          return {
            name,
            sourceType: name,
            async *sync(): AsyncIterable<SourceRecord> {
              await new Promise((r) => setTimeout(r, 15));
              yield rec("slow:1", "s");
            },
            finalize: (): SyncResult => ({ cursor: null }),
          };
        }
        return fakeConnector(name, [rec(`${name}:1`, "b")]);
      },
    });
    expect(result.results.map((r) => r.connector)).toEqual(names);
    expect(result.succeeded).toBe(3);
  });

  test("partial failure stays isolated under parallelism (ADR-0014, exit-code parity)", async () => {
    const names = ["ok1", "boom", "partial", "ok2"];
    const errors: string[] = [];
    const result = await runBulkSync(store, {
      names,
      connectors: Object.fromEntries(names.map((n) => [n, {}])),
      concurrency: 4,
      loadConnector: async (name) => {
        if (name === "boom") throw new Error("no token");
        if (name === "partial") {
          return {
            name,
            sourceType: name,
            async *sync(): AsyncIterable<SourceRecord> {
              yield rec("partial:1", "kept");
            },
            finalize: (): SyncResult => ({
              cursor: null,
              partialFailure: true,
              summaryLines: ["units: a=ok, b=failed (cursor preserved)"],
            }),
          };
        }
        return fakeConnector(name, [rec(`${name}:1`, "b")]);
      },
      onConnectorError: (c, e) => errors.push(`${c}: ${e.message}`),
    });

    expect(result.succeeded).toBe(2); // ok1, ok2
    expect(result.failed).toBe(2); // boom (threw), partial (partialFailure)
    expect(result.results.map((r) => r.connector)).toEqual(names); // deterministic order
    expect(result.results.find((r) => r.connector === "boom")?.error).toContain("no token");
    const partial = result.results.find((r) => r.connector === "partial");
    expect(partial?.ok).toBe(false);
    expect(partial?.outcome?.observed).toBe(1); // records kept
    expect(errors.sort()).toEqual(
      [
        "boom: no token",
        "partial: partial failure (units: a=ok, b=failed (cursor preserved))",
      ].sort(),
    );
  });

  test("concurrency > 8 warns via onWarn but still runs every connector", async () => {
    const warnings: string[] = [];
    const names = ["a", "b", "c"];
    const result = await runBulkSync(store, {
      names,
      connectors: Object.fromEntries(names.map((n) => [n, {}])),
      concurrency: 16,
      loadConnector: async (name) => fakeConnector(name, [rec(`${name}:1`, "b")]),
      syncOptions: { onWarn: (m) => warnings.push(m) },
    });
    expect(result.succeeded).toBe(3);
    expect(warnings.some((w) => w.includes("exceeds the recommended max"))).toBe(true);
  });

  test("fail-fast (continueOnError: false) stays serial and stops at the first failure", async () => {
    // With parallelism disabled, the original ADR-0027 serial semantics hold:
    // connectors after the failure never run and are absent from the result.
    const ran: string[] = [];
    const result = await runBulkSync(store, {
      names: ["good", "bad", "after"],
      connectors: { good: {}, bad: {}, after: {} },
      continueOnError: false,
      concurrency: 4, // ignored on the fail-fast path
      loadConnector: async (name) => {
        ran.push(name);
        if (name === "bad") throw new Error("boom");
        return fakeConnector(name, [rec(`${name}:1`, "body")]);
      },
    });
    expect(ran).toEqual(["good", "bad"]); // "after" never ran
    expect(result.results.map((r) => r.connector)).toEqual(["good", "bad"]);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
  });
});
