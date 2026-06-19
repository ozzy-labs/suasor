import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../../src/db/index.ts";
import { decisionRecord } from "../../src/propose/decision-record.ts";

let store: Store;

beforeEach(() => {
  store = Store.open({ path: ":memory:" });
});

afterEach(() => {
  store.close();
});

function decisions() {
  return store.connection.sqlite
    .query("SELECT id, title, rationale FROM decisions")
    .all() as Array<{ id: string; title: string; rationale: string }>;
}

describe("decision.record (direct HITL decision recording, #88)", () => {
  test("appends DecisionRecorded → decisions projection", () => {
    const out = decisionRecord(store, {
      title: "adopt event sourcing",
      rationale: "rebuildable projections",
    });
    expect(out.status).toBe("created");
    const rows = decisions();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("adopt event sourcing");
    expect(rows[0]?.rationale).toBe("rebuildable projections");
    expect(rows[0]?.id).toBe(out.decisionId);
  });

  test("defaults rationale to empty string", () => {
    decisionRecord(store, { title: "no rationale" });
    expect(decisions()[0]?.rationale).toBe("");
  });

  test("records provenance links to source ids", () => {
    decisionRecord(store, { title: "from sources", sourceExternalIds: ["gh:1", "gh:2"] });
    const links = store.connection.sqlite
      .query("SELECT to_id FROM links WHERE from_kind = 'decision' AND relation = 'derived_from'")
      .all() as Array<{ to_id: string }>;
    expect(links.map((l) => l.to_id).sort()).toEqual(["gh:1", "gh:2"]);
  });

  test("is idempotent on content: re-recording the same decision is a no-op", () => {
    const first = decisionRecord(store, { title: "dup", sourceExternalIds: ["gh:1"] });
    expect(first.status).toBe("created");
    const second = decisionRecord(store, { title: "dup", sourceExternalIds: ["gh:1"] });
    expect(second.status).toBe("existing");
    expect(second.decisionId).toBe(first.decisionId);
    expect(decisions()).toHaveLength(1);
  });

  test("rejects an empty title", () => {
    expect(() => decisionRecord(store, { title: "" })).toThrow();
  });
});
