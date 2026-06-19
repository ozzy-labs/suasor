import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../../src/db/index.ts";
import { linkAdd } from "../../src/propose/link-add.ts";

let store: Store;

beforeEach(() => {
  store = Store.open({ path: ":memory:" });
});

afterEach(() => {
  store.close();
});

function manualLinks() {
  return store.connection.sqlite
    .query(
      "SELECT from_kind, from_id, to_kind, to_id, relation, link_id FROM links WHERE relation = 'manual_link'",
    )
    .all() as Array<{
    from_kind: string;
    from_id: string;
    to_kind: string;
    to_id: string;
    relation: string;
    link_id: string;
  }>;
}

describe("link.add (manual link CRUD, #90)", () => {
  test("appends LinkAdded → a manual_link row in the links projection", () => {
    const out = linkAdd(store, { fromKind: "task", fromId: "t1", toKind: "decision", toId: "d1" });
    expect(out.status).toBe("created");
    const rows = manualLinks();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      from_kind: "task",
      from_id: "t1",
      to_kind: "decision",
      to_id: "d1",
      relation: "manual_link",
      link_id: out.linkId,
    });
  });

  test("is idempotent on the directed endpoint pair: re-adding is a no-op", () => {
    const first = linkAdd(store, { fromKind: "task", fromId: "t1", toKind: "source", toId: "s1" });
    expect(first.status).toBe("created");
    const second = linkAdd(store, { fromKind: "task", fromId: "t1", toKind: "source", toId: "s1" });
    expect(second.status).toBe("existing");
    expect(second.linkId).toBe(first.linkId);
    expect(manualLinks()).toHaveLength(1);
  });

  test("direction matters: A→B and B→A are distinct links", () => {
    const ab = linkAdd(store, { fromKind: "task", fromId: "a", toKind: "task", toId: "b" });
    const ba = linkAdd(store, { fromKind: "task", fromId: "b", toKind: "task", toId: "a" });
    expect(ab.linkId).not.toBe(ba.linkId);
    expect(manualLinks()).toHaveLength(2);
  });

  test("rejects a self-loop (same kind + id on both ends)", () => {
    expect(() =>
      linkAdd(store, { fromKind: "task", fromId: "t1", toKind: "task", toId: "t1" }),
    ).toThrow(/itself/);
    expect(manualLinks()).toHaveLength(0);
  });

  test("rejects empty endpoint fields", () => {
    expect(() =>
      linkAdd(store, { fromKind: "", fromId: "t1", toKind: "source", toId: "s1" }),
    ).toThrow();
  });
});
