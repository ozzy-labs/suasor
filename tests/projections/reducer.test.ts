import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../../src/db/index.ts";

let store: Store;

beforeEach(() => {
  store = Store.open({ path: ":memory:" });
});

afterEach(() => {
  store.close();
});

function rows(store: Store, table: string): unknown[] {
  return store.connection.sqlite.query(`SELECT * FROM ${table} ORDER BY 1`).all();
}

describe("SourceObserved / SourceBodyUpdated", () => {
  test("SourceObserved inserts a source row and FTS entry", () => {
    store.record(
      {
        type: "SourceObserved",
        externalId: "gh:1",
        sourceType: "github_issue",
        body: "deploy the rocket",
        observedAt: "2026-06-14T00:00:00.000Z",
        fingerprint: "fp1",
        meta: {},
      },
      new Date("2026-06-14T00:00:01.000Z"),
    );

    const src = rows(store, "sources") as Array<{ external_id: string; body: string }>;
    expect(src).toHaveLength(1);
    expect(src[0]?.body).toBe("deploy the rocket");

    const hits = store.connection.sqlite
      .query("SELECT external_id FROM sources_fts WHERE sources_fts MATCH ?")
      .all('"deploy"');
    expect(hits).toHaveLength(1);
  });

  test("SourceBodyUpdated updates body + FTS, leaving source_type", () => {
    const now = new Date("2026-06-14T00:00:00.000Z");
    store.record(
      {
        type: "SourceObserved",
        externalId: "gh:1",
        sourceType: "github_issue",
        body: "alpha",
        observedAt: "2026-06-14T00:00:00.000Z",
        fingerprint: "fp1",
        meta: {},
      },
      now,
    );
    store.record(
      {
        type: "SourceBodyUpdated",
        externalId: "gh:1",
        body: "bravo charlie",
        observedAt: "2026-06-15T00:00:00.000Z",
        fingerprint: "fp2",
        meta: {},
      },
      now,
    );

    const src = rows(store, "sources") as Array<{ source_type: string; body: string }>;
    expect(src[0]?.source_type).toBe("github_issue");
    expect(src[0]?.body).toBe("bravo charlie");

    const stale = store.connection.sqlite
      .query("SELECT external_id FROM sources_fts WHERE sources_fts MATCH ?")
      .all('"alpha"');
    expect(stale).toHaveLength(0);
  });

  test("SourceBodyUpdated without a prior source is a no-op (no orphan FTS row)", () => {
    store.record(
      {
        type: "SourceBodyUpdated",
        externalId: "ghost:1",
        body: "orphan body text",
        observedAt: "2026-06-15T00:00:00.000Z",
        fingerprint: "fpX",
        meta: {},
      },
      new Date("2026-06-15T00:00:00.000Z"),
    );

    expect(rows(store, "sources")).toHaveLength(0);
    const ftsRows = store.connection.sqlite.query("SELECT external_id FROM sources_fts").all();
    expect(ftsRows).toHaveLength(0);
  });
});

describe("tasks lifecycle", () => {
  test("TaskProposed then TaskApplied transitions state and links provenance", () => {
    const now = new Date("2026-06-14T00:00:00.000Z");
    store.record(
      { type: "TaskProposed", taskId: "t1", title: "ship it", sourceExternalIds: ["gh:1"] },
      now,
    );
    let task = rows(store, "tasks") as Array<{ state: string; title: string }>;
    expect(task[0]?.state).toBe("proposed");
    expect(task[0]?.title).toBe("ship it");

    store.record({ type: "TaskApplied", taskId: "t1", state: "in_progress" }, now);
    task = rows(store, "tasks") as Array<{ state: string; title: string }>;
    expect(task[0]?.state).toBe("in_progress");
    // title preserved from the proposal
    expect(task[0]?.title).toBe("ship it");

    const links = rows(store, "links") as Array<{ relation: string; to_id: string }>;
    expect(links).toHaveLength(1);
    expect(links[0]?.relation).toBe("derived_from");
    expect(links[0]?.to_id).toBe("gh:1");
  });
});

describe("decisions / inbox / reply drafts", () => {
  test("DecisionRecorded upserts a decision and link", () => {
    store.record(
      {
        type: "DecisionRecorded",
        decisionId: "d1",
        title: "use bun",
        rationale: "fast",
        sourceExternalIds: ["gh:2"],
      },
      new Date("2026-06-14T00:00:00.000Z"),
    );
    const dec = rows(store, "decisions") as Array<{ title: string; rationale: string }>;
    expect(dec[0]?.title).toBe("use bun");
    expect(dec[0]?.rationale).toBe("fast");
    expect(rows(store, "links")).toHaveLength(1);
  });

  test("InboxItemTriaged upserts inbox state and reference link", () => {
    store.record(
      { type: "InboxItemTriaged", inboxId: "i1", sourceExternalId: "gh:3", state: "done" },
      new Date("2026-06-14T00:00:00.000Z"),
    );
    const items = rows(store, "inbox") as Array<{ state: string; source_external_id: string }>;
    expect(items[0]?.state).toBe("done");
    expect(items[0]?.source_external_id).toBe("gh:3");
  });

  test("ReplyDraftProposed records a replies_to link only", () => {
    store.record(
      { type: "ReplyDraftProposed", draftId: "r1", replyToExternalId: "gh:4", body: "thanks" },
      new Date("2026-06-14T00:00:00.000Z"),
    );
    const links = rows(store, "links") as Array<{ relation: string }>;
    expect(links[0]?.relation).toBe("replies_to");
  });

  test("links are not duplicated under re-application", () => {
    const now = new Date("2026-06-14T00:00:00.000Z");
    // Two proposals for the same task/source pair must not duplicate the link.
    store.record(
      { type: "TaskProposed", taskId: "t1", title: "a", sourceExternalIds: ["gh:1"] },
      now,
    );
    store.record(
      { type: "TaskProposed", taskId: "t1", title: "a (refined)", sourceExternalIds: ["gh:1"] },
      now,
    );
    expect(rows(store, "links")).toHaveLength(1);
  });
});
