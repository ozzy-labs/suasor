/**
 * propose.apply idempotency scoped to the proposal round-trip ([boundary/
 * propose-1], Issue #435).
 *
 * Two distinct dedupe paths:
 *   - persisted flow (persistProposals → apply): re-applying an approved candidate
 *     is a no-op keyed on the candidateId round-trip (`skipReason: already_applied`),
 *     and the ledger row still flips to `applied` (marked by entity_id);
 *   - ledger-less flow (pure generate → apply, or a direct call): a task whose
 *     prior instance is terminal mints a fresh recurrence id so an identically
 *     content task can coexist instead of being blocked for the store's lifetime.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../../src/db/index.ts";
import { listProposals } from "../../src/mcp/queries.ts";
import { proposeApply } from "../../src/propose/apply.ts";
import type { Candidate } from "../../src/propose/candidates.ts";
import { persistProposals, proposeGenerate } from "../../src/propose/generate.ts";

let store: Store;

beforeEach(() => {
  store = Store.open({ path: ":memory:" });
});

afterEach(() => {
  store.close();
});

const sqlite = () => store.connection.sqlite;

function tasks() {
  return sqlite().query("SELECT id, state FROM tasks").all() as Array<{
    id: string;
    state: string;
  }>;
}

function countEvents(): number {
  return sqlite().query<{ n: number }, []>("SELECT COUNT(*) n FROM events").get()?.n ?? -1;
}

describe("propose.apply — round-trip scoped idempotency (persisted ledger)", () => {
  test("re-applying an approved candidate is a no-op keyed on the round-trip", () => {
    const generated = persistProposals(store, {
      mode: "source_extract",
      candidates: [{ kind: "task", title: "ship it", sourceExternalIds: ["gh:1"] }],
    });
    const candidates = generated.candidates as Candidate[];

    const first = proposeApply(store, { candidates });
    expect(first.applied).toBe(1);
    expect(first.results[0]?.status).toBe("applied");
    // The ledger flipped to applied (marked by entity_id).
    expect(listProposals(sqlite(), { state: "applied" })).toHaveLength(1);
    const eventsAfterFirst = countEvents();

    const second = proposeApply(store, { candidates });
    expect(second.applied).toBe(0);
    expect(second.skipped).toBe(1);
    expect(second.results[0]?.status).toBe("skipped");
    expect(second.results[0]?.skipReason).toBe("already_applied");
    // The reported entity id is the applied task's id (from the ledger row).
    expect(second.results[0]?.entityId).toBe(first.results[0]?.entityId);
    expect(countEvents()).toBe(eventsAfterFirst);
    expect(tasks()).toHaveLength(1);
  });

  test("a decision round-trip re-apply is also skipped as already_applied", () => {
    const generated = persistProposals(store, {
      mode: "meeting_followup",
      candidates: [{ kind: "decision", title: "use bun", rationale: "fast" }],
    });
    const candidates = generated.candidates as Candidate[];
    proposeApply(store, { candidates });
    const second = proposeApply(store, { candidates });
    expect(second.results[0]?.skipReason).toBe("already_applied");
    expect(sqlite().query("SELECT 1 FROM decisions").all()).toHaveLength(1);
  });
});

describe("propose.apply — ledger-less task coexistence after terminal history", () => {
  test("a purely-terminal prior instance mints a fresh recurrence id (coexists)", () => {
    // Pure generate → apply leaves NO ledger row, so idempotency falls back to the
    // terminal-aware task resolver.
    const gen = proposeGenerate({
      mode: "source_extract",
      candidates: [{ kind: "task", title: "経費精算", sourceExternalIds: [] }],
    });
    const candidates = gen.candidates;
    const first = proposeApply(store, { candidates });
    const baseId = first.results[0]?.entityId as string;
    expect(first.applied).toBe(1);

    // Complete the first instance (terminal).
    store.record({ type: "TaskApplied", taskId: baseId, state: "completed" });

    // Re-applying the same content now creates a disambiguated recurrence.
    const second = proposeApply(store, { candidates });
    expect(second.applied).toBe(1);
    expect(second.results[0]?.status).toBe("applied");
    expect(second.results[0]?.entityId).toBe(`${baseId}~2`);
    expect(tasks()).toHaveLength(2);
  });

  test("a still-open ledger-less task instance is skipped as existing (not duplicated)", () => {
    const gen = proposeGenerate({
      mode: "source_extract",
      candidates: [{ kind: "task", title: "still open", sourceExternalIds: [] }],
    });
    proposeApply(store, { candidates: gen.candidates });
    const second = proposeApply(store, { candidates: gen.candidates });
    expect(second.results[0]?.status).toBe("skipped");
    expect(second.results[0]?.skipReason).toBe("exists");
    expect(tasks()).toHaveLength(1);
  });
});
