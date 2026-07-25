import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../../src/db/index.ts";
import { proposeApply } from "../../src/propose/apply.ts";
import { persistProposals, proposeGenerate } from "../../src/propose/generate.ts";

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

describe("propose.apply — round-trip idempotence (#435)", () => {
  test("dedupes duplicate candidates within a single apply call (no ledger row needed)", () => {
    // Two identical task candidates in one call: the second is deduped by the
    // in-call candidateId map and echoes the id minted for the first.
    const gen = proposeGenerate({
      mode: "source_extract",
      candidates: [{ kind: "task", title: "same", sourceExternalIds: ["gh:1"] }],
    });
    const dup = [gen.candidates[0], gen.candidates[0]].filter((c) => c !== undefined);
    const out = proposeApply(store, { candidates: dup });
    expect(out.applied).toBe(1);
    expect(out.skipped).toBe(1);
    expect(out.results[0]?.entityId).toBe(out.results[1]?.entityId as string);
    expect(rows("tasks")).toHaveLength(1);
  });

  test("re-applying the same ledgered candidate appends NO second event (skipped)", () => {
    const generated = persistProposals(store, {
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
    // The skip echoes the entity id minted on the first apply (from the ledger).
    expect(second.results[0]?.entityId).toBe(first.results[0]?.entityId as string);
    // No new event appended on the idempotent re-apply.
    expect(countEvents()).toBe(eventsAfterFirst);
    // Projection still has exactly one task.
    expect(rows("tasks")).toHaveLength(1);
  });

  test("re-generating the same content yields the same candidateId, so the ledger skips re-apply", () => {
    const a = persistProposals(store, {
      mode: "meeting_followup",
      candidates: [{ kind: "decision", title: "d", rationale: "r" }],
    });
    proposeApply(store, { candidates: a.candidates });
    // Re-generating the same content is withheld as `decided` by persistProposals,
    // but a host may still round-trip the stamped candidate straight to apply —
    // the ledger (keyed by candidateId) makes that a skip, not a duplicate.
    const out = proposeApply(store, { candidates: a.candidates });
    expect(out.skipped).toBe(1);
    expect(rows("decisions")).toHaveLength(1);
  });

  test("distinct candidates with the SAME title but different provenance become distinct tasks", () => {
    // Recurring-title case ([boundary/propose-1]): January's and February's
    // "経費精算" derive from different sources → different candidateIds → two tasks.
    const jan = persistProposals(store, {
      mode: "source_extract",
      candidates: [{ kind: "task", title: "経費精算", sourceExternalIds: ["mail:jan"] }],
    });
    proposeApply(store, { candidates: jan.candidates });
    const feb = persistProposals(store, {
      mode: "source_extract",
      candidates: [{ kind: "task", title: "経費精算", sourceExternalIds: ["mail:feb"] }],
    });
    const out = proposeApply(store, { candidates: feb.candidates });
    expect(out.applied).toBe(1);
    const tasks = rows("tasks") as Array<{ id: string; title: string }>;
    expect(tasks).toHaveLength(2);
    expect(new Set(tasks.map((t) => t.id)).size).toBe(2);
  });

  test("equal content via different modes mints a `-N`-suffixed id instead of colliding", () => {
    // Same title + provenance through two modes → two candidateIds sharing one
    // base entity id. The second apply must mint a disambiguated id, not skip.
    const viaExtract = persistProposals(store, {
      mode: "source_extract",
      candidates: [{ kind: "task", title: "same content", sourceExternalIds: ["gh:1"] }],
    });
    proposeApply(store, { candidates: viaExtract.candidates });
    const viaMeeting = persistProposals(store, {
      mode: "meeting_followup",
      candidates: [{ kind: "task", title: "same content", sourceExternalIds: ["gh:1"] }],
    });
    const out = proposeApply(store, { candidates: viaMeeting.candidates });
    expect(out.applied).toBe(1);
    const ids = (rows("tasks") as Array<{ id: string }>).map((t) => t.id).sort();
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(`${ids[0]}-2`);
  });

  test("decisions with the same title but different rationale are distinct (no rationale collision)", () => {
    const a = persistProposals(store, {
      mode: "meeting_followup",
      candidates: [{ kind: "decision", title: "use bun", rationale: "fast" }],
    });
    proposeApply(store, { candidates: a.candidates });
    const b = persistProposals(store, {
      mode: "meeting_followup",
      candidates: [{ kind: "decision", title: "use bun", rationale: "single binary" }],
    });
    const out = proposeApply(store, { candidates: b.candidates });
    expect(out.applied).toBe(1);
    const decisions = rows("decisions") as Array<{ rationale: string }>;
    expect(decisions.map((d) => d.rationale).sort()).toEqual(["fast", "single binary"]);
  });

  test("a recurring title with EMPTY provenance still round-trips per candidate generation", () => {
    // The applied ledger row keeps the exact same candidate from re-applying,
    // while the tasks projection is free to hold the completed prior task and
    // the direct-create path (task.create) can mint the recurrence.
    const gen = persistProposals(store, {
      mode: "source_extract",
      candidates: [{ kind: "task", title: "経費精算", sourceExternalIds: [] }],
    });
    const first = proposeApply(store, { candidates: gen.candidates });
    expect(first.applied).toBe(1);
    const again = proposeApply(store, { candidates: gen.candidates });
    expect(again.skipped).toBe(1);
    expect(rows("tasks")).toHaveLength(1);
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

  test("the ledger row records the actually minted (suffixed) entity id once applied", () => {
    const first = persistProposals(store, {
      mode: "source_extract",
      candidates: [{ kind: "task", title: "t", sourceExternalIds: ["gh:1"] }],
    });
    proposeApply(store, { candidates: first.candidates });
    const second = persistProposals(store, {
      mode: "meeting_followup",
      candidates: [{ kind: "task", title: "t", sourceExternalIds: ["gh:1"] }],
    });
    const out = proposeApply(store, { candidates: second.candidates });
    const mintedId = out.results[0]?.entityId as string;
    expect(mintedId.endsWith("-2")).toBe(true);
    const ledger = store.connection.sqlite
      .query<{ entity_id: string; state: string }, [string]>(
        "SELECT entity_id, state FROM proposals WHERE candidate_id = ?",
      )
      .get(second.candidates[0]?.candidateId as string);
    expect(ledger?.state).toBe("applied");
    expect(ledger?.entity_id).toBe(mintedId);
  });

  test("minted ids survive a projection rebuild identically (event-sourced, ADR-0002)", () => {
    // Two same-content candidates through different modes → base id + `-2`.
    // The minted ids are baked into the events, so replay reproduces them.
    for (const mode of ["source_extract", "meeting_followup"] as const) {
      const gen = persistProposals(store, {
        mode,
        candidates: [{ kind: "task", title: "recur", sourceExternalIds: ["gh:1"] }],
      });
      proposeApply(store, { candidates: gen.candidates });
    }
    const before = (rows("tasks") as Array<{ id: string }>).map((t) => t.id).sort();
    store.rebuild();
    const after = (rows("tasks") as Array<{ id: string }>).map((t) => t.id).sort();
    expect(after).toEqual(before);
    expect(after).toHaveLength(2);
    // The ledger converges to the same applied rows too.
    const states = store.connection.sqlite
      .query<{ state: string }, []>("SELECT state FROM proposals")
      .all()
      .map((r) => r.state);
    expect(states).toEqual(["applied", "applied"]);
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
