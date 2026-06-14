import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../../src/db/index.ts";
import { proposeApply } from "../../src/propose/apply.ts";
import { proposeGenerate } from "../../src/propose/generate.ts";

let store: Store;

beforeEach(() => {
  store = Store.open({ path: ":memory:" });
});

afterEach(() => {
  store.close();
});

function rows(table: string): unknown[] {
  return store.connection.sqlite.query(`SELECT * FROM ${table}`).all();
}

function countEvents(): number {
  return (
    store.connection.sqlite.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()?.n ??
    -1
  );
}

/** generate → apply for a single candidate; returns the apply output. */
function generateApply(
  mode: Parameters<typeof proposeGenerate>[0]["mode"],
  candidate: Parameters<typeof proposeGenerate>[0]["candidates"][number],
) {
  const generated = proposeGenerate({ mode, candidates: [candidate] });
  return proposeApply(store, { candidates: generated.candidates });
}

describe("propose.apply — candidate → event mapping", () => {
  test("task candidate appends TaskProposed and folds the tasks projection", () => {
    const out = generateApply("source_extract", {
      kind: "task",
      title: "ship it",
      sourceExternalIds: ["gh:1"],
    });
    expect(out.applied).toBe(1);
    const tasks = rows("tasks") as Array<{ title: string; state: string }>;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.title).toBe("ship it");
    expect(tasks[0]?.state).toBe("proposed");
    // Provenance link recorded.
    const links = rows("links") as Array<{ relation: string; to_id: string }>;
    expect(links[0]?.relation).toBe("derived_from");
    expect(links[0]?.to_id).toBe("gh:1");
  });

  test("decision candidate appends DecisionRecorded", () => {
    generateApply("meeting_followup", { kind: "decision", title: "use bun", rationale: "fast" });
    const decisions = rows("decisions") as Array<{ title: string; rationale: string }>;
    expect(decisions[0]?.title).toBe("use bun");
    expect(decisions[0]?.rationale).toBe("fast");
  });

  test("reply_draft candidate appends ReplyDraftProposed (replies_to link only)", () => {
    generateApply("reply_draft", { kind: "reply_draft", replyToExternalId: "gh:9", body: "ok" });
    expect(rows("tasks")).toHaveLength(0);
    const links = rows("links") as Array<{ relation: string; from_kind: string }>;
    expect(links[0]?.from_kind).toBe("reply_draft");
    expect(links[0]?.relation).toBe("replies_to");
  });

  test("triage candidate appends InboxItemTriaged with the chosen state", () => {
    generateApply("inbox_triage", {
      kind: "triage",
      inboxId: "i1",
      sourceExternalId: "gh:1",
      state: "done",
    });
    const items = rows("inbox") as Array<{ id: string; state: string }>;
    expect(items[0]?.id).toBe("i1");
    expect(items[0]?.state).toBe("done");
  });

  test("applies a mixed candidate set in one call, reporting per-candidate results", () => {
    const generated = proposeGenerate({
      mode: "source_extract",
      candidates: [
        { kind: "task", title: "a", sourceExternalIds: [] },
        { kind: "decision", title: "b", rationale: "" },
        { kind: "reply_draft", replyToExternalId: "gh:1", body: "c" },
      ],
    });
    const out = proposeApply(store, { candidates: generated.candidates });
    expect(out.applied).toBe(3);
    expect(out.results.map((r) => r.status)).toEqual(["applied", "applied", "applied"]);
  });
});

describe("propose.apply — idempotence (acceptance criterion)", () => {
  test("dedupes duplicate candidates within a single apply call", () => {
    // Two identical task candidates in one call: the second sees the first's
    // committed row (Store.record folds synchronously) and is skipped.
    const gen = proposeGenerate({
      mode: "source_extract",
      candidates: [{ kind: "task", title: "same", sourceExternalIds: ["gh:1"] }],
    });
    const dup = [gen.candidates[0], gen.candidates[0]].filter((c) => c !== undefined);
    const out = proposeApply(store, { candidates: dup });
    expect(out.applied).toBe(1);
    expect(out.skipped).toBe(1);
    expect(rows("tasks")).toHaveLength(1);
  });

  test("re-applying the same candidate appends NO second event (skipped)", () => {
    const generated = proposeGenerate({
      mode: "source_extract",
      candidates: [{ kind: "task", title: "ship it", sourceExternalIds: ["gh:1"] }],
    });
    const first = proposeApply(store, { candidates: generated.candidates });
    expect(first.applied).toBe(1);
    const eventsAfterFirst = countEvents();

    const second = proposeApply(store, { candidates: generated.candidates });
    expect(second.applied).toBe(0);
    expect(second.skipped).toBe(1);
    expect(second.results[0]?.status).toBe("skipped");
    // No new event appended on the idempotent re-apply.
    expect(countEvents()).toBe(eventsAfterFirst);
    // Projection still has exactly one task.
    expect(rows("tasks")).toHaveLength(1);
  });

  test("generate is deterministic: re-generating gives the same entity id, so apply skips", () => {
    const a = proposeGenerate({
      mode: "meeting_followup",
      candidates: [{ kind: "decision", title: "d", rationale: "r" }],
    });
    proposeApply(store, { candidates: a.candidates });
    const b = proposeGenerate({
      mode: "meeting_followup",
      candidates: [{ kind: "decision", title: "d", rationale: "r" }],
    });
    const out = proposeApply(store, { candidates: b.candidates });
    expect(out.skipped).toBe(1);
    expect(rows("decisions")).toHaveLength(1);
  });

  test("re-applying a reply_draft with the same body is idempotent (no duplicate link)", () => {
    const gen = proposeGenerate({
      mode: "reply_draft",
      candidates: [{ kind: "reply_draft", replyToExternalId: "gh:1", body: "hi" }],
    });
    proposeApply(store, { candidates: gen.candidates });
    const out = proposeApply(store, { candidates: gen.candidates });
    expect(out.skipped).toBe(1);
    expect(rows("links")).toHaveLength(1);
  });

  test("re-triaging an inbox item to the SAME state is a no-op, but a DIFFERENT state applies", () => {
    const toSnoozed = proposeGenerate({
      mode: "inbox_triage",
      candidates: [{ kind: "triage", inboxId: "i1", sourceExternalId: "gh:1", state: "snoozed" }],
    });
    proposeApply(store, { candidates: toSnoozed.candidates });
    // Same state again → skipped.
    expect(proposeApply(store, { candidates: toSnoozed.candidates }).skipped).toBe(1);

    // Moving to a different state still applies (progresses the workflow).
    const toDone = proposeGenerate({
      mode: "inbox_triage",
      candidates: [{ kind: "triage", inboxId: "i1", sourceExternalId: "gh:1", state: "done" }],
    });
    const out = proposeApply(store, { candidates: toDone.candidates });
    expect(out.applied).toBe(1);
    const items = rows("inbox") as Array<{ state: string }>;
    expect(items).toHaveLength(1);
    expect(items[0]?.state).toBe("done");
  });

  test("applied candidates survive a projection rebuild (event-sourced, ADR-0002)", () => {
    const gen = proposeGenerate({
      mode: "source_extract",
      candidates: [{ kind: "task", title: "rebuildable", sourceExternalIds: [] }],
    });
    proposeApply(store, { candidates: gen.candidates });
    store.rebuild();
    const tasks = rows("tasks") as Array<{ title: string }>;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.title).toBe("rebuildable");
  });
});

describe("propose — no auto-apply invariant (ADR-0004 / FR-PRO-2)", () => {
  test("generate alone writes nothing to the store", () => {
    const before = countEvents();
    proposeGenerate({
      mode: "source_extract",
      candidates: [{ kind: "task", title: "should not persist", sourceExternalIds: [] }],
    });
    expect(countEvents()).toBe(before);
    expect(rows("tasks")).toHaveLength(0);
  });
});
