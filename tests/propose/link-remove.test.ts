import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../../src/db/index.ts";
import { linkAdd } from "../../src/propose/link-add.ts";
import { linkRemove } from "../../src/propose/link-remove.ts";

let store: Store;

beforeEach(() => {
  store = Store.open({ path: ":memory:" });
});

afterEach(() => {
  store.close();
});

function manualLinkCount(): number {
  const row = store.connection.sqlite
    .query("SELECT COUNT(*) AS n FROM links WHERE relation = 'manual_link'")
    .get() as { n: number };
  return row.n;
}

describe("link.remove (manual link CRUD, #90)", () => {
  test("removes a manual link by id (it disappears from the projection)", () => {
    const add = linkAdd(store, { fromKind: "task", fromId: "t1", toKind: "decision", toId: "d1" });
    expect(manualLinkCount()).toBe(1);
    const out = linkRemove(store, { linkId: add.linkId });
    expect(out.status).toBe("removed");
    expect(out.linkId).toBe(add.linkId);
    expect(manualLinkCount()).toBe(0);
  });

  test("rejects removing a non-existent link", () => {
    expect(() => linkRemove(store, { linkId: "link_missing" })).toThrow(/no manual link/);
  });

  test("rejects removing an already-removed link (double remove)", () => {
    const add = linkAdd(store, { fromKind: "task", fromId: "t1", toKind: "source", toId: "s1" });
    linkRemove(store, { linkId: add.linkId });
    expect(() => linkRemove(store, { linkId: add.linkId })).toThrow(/no manual link/);
  });

  test("does not touch reducer-derived links (only manual links are removable)", () => {
    // A derived edge (task → source via TaskProposed) has a NULL link_id.
    store.record({ type: "TaskProposed", taskId: "t9", title: "t", sourceExternalIds: ["s9"] });
    const derived = store.connection.sqlite
      .query("SELECT link_id FROM links WHERE relation = 'derived_from'")
      .all() as Array<{ link_id: string | null }>;
    expect(derived).toHaveLength(1);
    expect(derived[0]?.link_id).toBeNull();
    // It has no link_id, so link.remove cannot target it.
    expect(() => linkRemove(store, { linkId: "anything" })).toThrow(/no manual link/);
  });
});

describe("manual link replay determinism (event-sourced, ADR-0002)", () => {
  test("add then remove → rebuild yields no manual link row", () => {
    const add = linkAdd(store, { fromKind: "task", fromId: "t1", toKind: "decision", toId: "d1" });
    linkRemove(store, { linkId: add.linkId });
    store.rebuild();
    expect(manualLinkCount()).toBe(0);
  });

  test("add (no remove) → rebuild restores the manual link row", () => {
    linkAdd(store, { fromKind: "task", fromId: "t1", toKind: "decision", toId: "d1" });
    const before = manualLinkCount();
    store.rebuild();
    expect(manualLinkCount()).toBe(before);
    expect(manualLinkCount()).toBe(1);
  });
});
