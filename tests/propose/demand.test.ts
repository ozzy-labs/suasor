/**
 * Demand seen-state services (ADR-0041), reached via the demand.mark tool, over the
 * derived demand rows, folding into the `demand_seen` projection so a handled /
 * irrelevant mention drops out of the default demand.list. Covers the
 * status-reporting contract (acked / dismissed / already_* / missing),
 * last-write-wins transitions, and rebuild idempotence.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../../src/db/index.ts";
import { listDemand } from "../../src/mcp/queries.ts";
import { demandAck, demandDismiss } from "../../src/propose/demand.ts";

let store: Store;

beforeEach(() => {
  store = Store.open({ path: ":memory:" });
});

afterEach(() => {
  store.close();
});

/** Seed a slack DM demand source (its external_id is the seen key). */
function slackDm(externalId: string, observedAt = "2026-06-14T00:00:00.000Z") {
  store.record({
    type: "SourceObserved",
    externalId,
    sourceType: "slack_message",
    body: `dm ${externalId}`,
    observedAt,
    fingerprint: externalId,
    meta: { team: "T1", channel: "D9" },
  });
}

describe("demandAck / demandDismiss (ADR-0041)", () => {
  test("ack marks an existing demand row acked and removes it from the default list", () => {
    slackDm("d1");
    expect(listDemand(store.connection.sqlite).map((r) => r.externalId)).toEqual(["d1"]);
    const out = demandAck(store, { externalId: "d1" });
    expect(out).toEqual({ externalId: "d1", status: "acked", seenState: "acked" });
    // Dropped from the default (un-acked) list; visible with includeSeen.
    expect(listDemand(store.connection.sqlite)).toEqual([]);
    const [seen] = listDemand(store.connection.sqlite, { includeSeen: true });
    expect(seen?.seenState).toBe("acked");
  });

  test("dismiss marks a demand row dismissed", () => {
    slackDm("d1");
    const out = demandDismiss(store, { externalId: "d1" });
    expect(out).toEqual({ externalId: "d1", status: "dismissed", seenState: "dismissed" });
    expect(listDemand(store.connection.sqlite)).toEqual([]);
  });

  test("re-acking is a no-op (already_acked); acking a dismissed row flips it (LWW)", () => {
    slackDm("d1");
    demandAck(store, { externalId: "d1" });
    expect(demandAck(store, { externalId: "d1" }).status).toBe("already_acked");
    demandDismiss(store, { externalId: "d1" }); // now dismissed
    // Acking a dismissed row is a valid "I did handle it" correction.
    expect(demandAck(store, { externalId: "d1" }).status).toBe("acked");
  });

  test("re-dismissing is a no-op (already_dismissed)", () => {
    slackDm("d1");
    demandDismiss(store, { externalId: "d1" });
    expect(demandDismiss(store, { externalId: "d1" }).status).toBe("already_dismissed");
  });

  test("an unknown source is reported missing (no event appended)", () => {
    const out = demandAck(store, { externalId: "ghost" });
    expect(out).toEqual({ externalId: "ghost", status: "missing", seenState: null });
    // Nothing was folded.
    const count = store.connection.sqlite
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM demand_seen")
      .get();
    expect(count?.n).toBe(0);
  });

  test("seen-state survives a rebuild (event-sourced, ADR-0002)", () => {
    slackDm("d1");
    demandAck(store, { externalId: "d1" });
    store.rebuild();
    expect(listDemand(store.connection.sqlite)).toEqual([]);
  });
});
