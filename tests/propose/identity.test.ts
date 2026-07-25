/**
 * Apply-time entity-identity resolution (#435, [boundary/propose-1]):
 * `mintEntityId` walks the base id's `-N` sequence to the first free slot, and
 * `resolveTaskIdentity` distinguishes live duplicates (block re-creation, are
 * reported) from terminal ones (do not block — recurring titles stay usable).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../../src/db/index.ts";
import { entityId } from "../../src/propose/id.ts";
import { mintEntityId, resolveTaskIdentity } from "../../src/propose/identity.ts";

let store: Store;

beforeEach(() => {
  store = Store.open({ path: ":memory:" });
});

afterEach(() => {
  store.close();
});

const sqlite = () => store.connection.sqlite;

const taskCandidate = {
  kind: "task" as const,
  candidateId: "cand_x",
  title: "経費精算",
  sourceExternalIds: [] as string[],
};

function proposeTask(taskId: string): void {
  store.record({ type: "TaskProposed", taskId, title: "経費精算", sourceExternalIds: [] });
}

describe("mintEntityId (#435)", () => {
  test("returns the content-derived base id while it is free", () => {
    expect(mintEntityId(sqlite(), taskCandidate)).toBe(entityId(taskCandidate));
  });

  test("walks the -N suffix sequence past occupied ids (any state occupies)", () => {
    const base = entityId(taskCandidate);
    proposeTask(base);
    expect(mintEntityId(sqlite(), taskCandidate)).toBe(`${base}-2`);
    proposeTask(`${base}-2`);
    // A terminal row still occupies its id — minting never reuses an id.
    store.record({ type: "TaskApplied", taskId: base, state: "completed" });
    expect(mintEntityId(sqlite(), taskCandidate)).toBe(`${base}-3`);
  });

  test("passes non-task/decision kinds through to the content-derived id", () => {
    const draft = {
      kind: "reply_draft" as const,
      candidateId: "cand_r",
      replyToExternalId: "gh:1",
      body: "hi",
    };
    expect(mintEntityId(sqlite(), draft)).toBe(entityId(draft));
  });
});

describe("resolveTaskIdentity (#435)", () => {
  test("no content match: freeId is the base id, no duplicate", () => {
    const { freeId, liveDuplicate } = resolveTaskIdentity(sqlite(), {
      title: "経費精算",
      sourceExternalIds: [],
    });
    expect(freeId).toBe(entityId(taskCandidate));
    expect(liveDuplicate).toBeNull();
  });

  test("reports the most recently updated LIVE duplicate when several exist", () => {
    const base = entityId(taskCandidate);
    proposeTask(base);
    proposeTask(`${base}-2`);
    // Touch the first one later: it becomes the most recently updated live row.
    store.record(
      { type: "TaskApplied", taskId: base, state: "in_progress" },
      new Date(Date.now() + 60_000),
    );
    const { freeId, liveDuplicate } = resolveTaskIdentity(sqlite(), {
      title: "経費精算",
      sourceExternalIds: [],
    });
    expect(freeId).toBe(`${base}-3`);
    expect(liveDuplicate?.taskId).toBe(base);
    expect(liveDuplicate?.state).toBe("in_progress");
  });

  test("terminal rows do not surface as duplicates (recurrence unblocked)", () => {
    const base = entityId(taskCandidate);
    proposeTask(base);
    store.record({ type: "TaskApplied", taskId: base, state: "dropped" });
    const { freeId, liveDuplicate } = resolveTaskIdentity(sqlite(), {
      title: "経費精算",
      sourceExternalIds: [],
    });
    expect(freeId).toBe(`${base}-2`);
    expect(liveDuplicate).toBeNull();
  });

  test("provenance is part of the content identity (different sources never collide)", () => {
    proposeTask(entityId(taskCandidate));
    const { liveDuplicate } = resolveTaskIdentity(sqlite(), {
      title: "経費精算",
      sourceExternalIds: ["mail:feb"],
    });
    expect(liveDuplicate).toBeNull();
  });
});
