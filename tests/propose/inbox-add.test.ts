import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../../src/db/index.ts";
import { inboxAdd } from "../../src/propose/inbox-add.ts";

let store: Store;

beforeEach(() => {
  store = Store.open({ path: ":memory:" });
});

afterEach(() => {
  store.close();
});

function inbox() {
  return store.connection.sqlite
    .query("SELECT id, source_external_id, state FROM inbox")
    .all() as Array<{ id: string; source_external_id: string; state: string }>;
}

describe("inbox.add (capture inbox item, #88)", () => {
  test("appends InboxItemTriaged (state open) → inbox projection", () => {
    const out = inboxAdd(store, { sourceExternalId: "gh:1" });
    expect(out.status).toBe("created");
    const rows = inbox();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source_external_id).toBe("gh:1");
    expect(rows[0]?.state).toBe("open");
    expect(rows[0]?.id).toBe(out.inboxId);
  });

  test("records a references link to the captured source", () => {
    inboxAdd(store, { sourceExternalId: "gh:1" });
    const links = store.connection.sqlite
      .query("SELECT to_id FROM links WHERE from_kind = 'inbox' AND relation = 'references'")
      .all() as Array<{ to_id: string }>;
    expect(links.map((l) => l.to_id)).toEqual(["gh:1"]);
  });

  test("is idempotent on the captured source: re-adding is a no-op", () => {
    const first = inboxAdd(store, { sourceExternalId: "gh:1" });
    expect(first.status).toBe("created");
    const second = inboxAdd(store, { sourceExternalId: "gh:1" });
    expect(second.status).toBe("existing");
    expect(second.inboxId).toBe(first.inboxId);
    expect(inbox()).toHaveLength(1);
  });

  test("distinct sources yield distinct inbox items", () => {
    inboxAdd(store, { sourceExternalId: "gh:1" });
    inboxAdd(store, { sourceExternalId: "gh:2" });
    expect(inbox()).toHaveLength(2);
  });

  test("rejects an empty sourceExternalId", () => {
    expect(() => inboxAdd(store, { sourceExternalId: "" })).toThrow();
  });
});
