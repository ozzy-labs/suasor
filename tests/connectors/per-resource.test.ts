import { describe, expect, test } from "bun:test";
import type { SourceRecord, SyncContext } from "../../src/connectors/contract.ts";
import { type IsolationResult, syncResourcesIsolated } from "../../src/connectors/per-resource.ts";

function ctx(overrides: Partial<SyncContext> = {}): SyncContext {
  return { cursor: null, secret: async () => null, ...overrides };
}

async function collect(it: AsyncIterable<SourceRecord>): Promise<SourceRecord[]> {
  const out: SourceRecord[] = [];
  for await (const r of it) out.push(r);
  return out;
}

/** A trivial record carrying its resource label in `body` for assertions. */
function rec(label: string): SourceRecord {
  return { externalId: label, sourceType: "test", body: label, observedAt: "", meta: {} };
}

describe("syncResourcesIsolated", () => {
  test("empty resource list yields nothing and reports a clean (no-failure) result", async () => {
    let result: IsolationResult | undefined;
    const records = await collect(
      syncResourcesIsolated<string>(
        [],
        ctx(),
        (r) => r,
        "thing",
        () => (async function* () {})(),
        (r) => {
          result = r;
        },
      ),
    );
    expect(records).toEqual([]);
    expect(result).toEqual({ okCount: 0, failures: [], partialFailure: false });
  });

  test("a clean multi-resource run yields every record and sets no summary line", async () => {
    let result: IsolationResult | undefined;
    const records = await collect(
      syncResourcesIsolated(
        ["a", "b"],
        ctx(),
        (r) => r,
        "thing",
        (r) =>
          (async function* () {
            yield rec(r);
          })(),
        (r) => {
          result = r;
        },
      ),
    );
    expect(records.map((r) => r.body)).toEqual(["a", "b"]);
    expect(result?.partialFailure).toBe(false);
    expect(result?.summaryLines).toBeUndefined();
    expect(result?.okCount).toBe(2);
  });

  test("a mid-stream failure keeps earlier records of the same resource that were already yielded", async () => {
    // The generator yields one record then throws — the early record is kept
    // (the consumer already received it) and the resource is still counted
    // failed, mirroring a connector that paged some items before a 403.
    const warns: string[] = [];
    let result: IsolationResult | undefined;
    const records = await collect(
      syncResourcesIsolated(
        ["a", "b"],
        ctx({ onWarn: (m) => warns.push(m) }),
        (r) => r,
        "thing",
        (r) =>
          (async function* () {
            yield rec(`${r}-1`);
            if (r === "a") throw new Error("403");
            yield rec(`${r}-2`);
          })(),
        (res) => {
          result = res;
        },
      ),
    );
    expect(records.map((r) => r.body)).toEqual(["a-1", "b-1", "b-2"]);
    expect(result?.partialFailure).toBe(true);
    expect(result?.failures).toEqual([{ resource: "a", message: "403" }]);
    expect(warns[0]).toBe("1 thing OK, 1 failed (cursor preserved) — a (403)");
  });

  test("all resources failing throws the last error and emits no warn", async () => {
    const warns: string[] = [];
    await expect(
      collect(
        syncResourcesIsolated(
          ["a", "b"],
          ctx({ onWarn: (m) => warns.push(m) }),
          (r) => r,
          "thing",
          (r) =>
            (async function* () {
              if (r) throw new Error(`fail-${r}`);
              yield rec(r); // unreachable; present so this is a valid generator
            })(),
          () => {},
        ),
      ),
    ).rejects.toThrow("fail-b");
    expect(warns).toEqual([]);
  });

  test("a non-Error thrown value is stringified into the failure message", async () => {
    let result: IsolationResult | undefined;
    await collect(
      syncResourcesIsolated(
        ["a", "b"],
        ctx({ onWarn: () => {} }),
        (r) => r,
        "thing",
        (r) =>
          (async function* () {
            if (r === "a") throw "string failure";
            yield rec(r);
          })(),
        (res) => {
          result = res;
        },
      ),
    );
    expect(result?.failures[0]?.message).toBe("string failure");
  });
});
