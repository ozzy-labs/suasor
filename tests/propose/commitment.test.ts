/**
 * Commitment ledger (ADR-0021): extraction (commitment_scan propose mode →
 * CommitmentOpened) + the HITL state machine (resolve / dismiss / reopen) +
 * rebuild idempotence.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../../src/db/index.ts";
import { listCommitments } from "../../src/mcp/queries.ts";
import { proposeApply } from "../../src/propose/apply.ts";
import {
  commitmentDismiss,
  commitmentReopen,
  commitmentResolve,
} from "../../src/propose/commitment.ts";
import { proposeGenerate } from "../../src/propose/generate.ts";

let store: Store;

beforeEach(() => {
  store = Store.open({ path: ":memory:" });
});

afterEach(() => {
  store.close();
});

/** Extract+apply one commitment via the propose pipeline; return its id. */
function openCommitment(
  candidate: {
    title: string;
    direction: "owed_by_me" | "owed_to_me";
    dueDate?: string | null;
    person?: string | null;
    sourceExternalIds?: string[];
  } = { title: "send the report by Friday", direction: "owed_by_me" },
): string {
  const generated = proposeGenerate({
    mode: "commitment_scan",
    candidates: [{ kind: "commitment", ...candidate }],
  });
  const out = proposeApply(store, { candidates: generated.candidates });
  const id = out.results[0]?.entityId;
  if (id === undefined) throw new Error("no commitment id");
  return id;
}

function commitmentRow(id: string) {
  return store.connection.sqlite
    .query("SELECT id, title, direction, state, due_date, person FROM commitments WHERE id = ?")
    .get(id) as
    | {
        id: string;
        title: string;
        direction: string;
        state: string;
        due_date: string | null;
        person: string | null;
      }
    | undefined;
}

describe("commitment extraction (commitment_scan → CommitmentOpened)", () => {
  test("only the commitment kind is allowed for the commitment_scan mode", () => {
    expect(() =>
      proposeGenerate({
        mode: "commitment_scan",
        candidates: [{ kind: "task", title: "nope", sourceExternalIds: [] }],
      }),
    ).toThrow();
  });

  test("apply opens a commitment in the ledger (state=open) with direction + context", () => {
    const id = openCommitment({
      title: "reply to the client by 2026-06-30",
      direction: "owed_by_me",
      dueDate: "2026-06-30T00:00:00Z",
      person: "alice",
      sourceExternalIds: ["gh:1"],
    });
    const row = commitmentRow(id);
    expect(row?.state).toBe("open");
    expect(row?.direction).toBe("owed_by_me");
    expect(row?.title).toBe("reply to the client by 2026-06-30");
    expect(row?.due_date).toBe("2026-06-30T00:00:00Z");
    expect(row?.person).toBe("alice");
    // Provenance link recorded (commitment → source, derived_from).
    const link = store.connection.sqlite
      .query("SELECT to_id, relation FROM links WHERE from_kind = 'commitment' AND from_id = ?")
      .get(id) as { to_id: string; relation: string } | undefined;
    expect(link?.to_id).toBe("gh:1");
    expect(link?.relation).toBe("derived_from");
  });

  test("dueDate / person default to null when omitted", () => {
    const id = openCommitment({ title: "vague promise", direction: "owed_to_me" });
    const row = commitmentRow(id);
    expect(row?.due_date).toBeNull();
    expect(row?.person).toBeNull();
  });

  test("re-extracting the same commitment is idempotent (skipped, no duplicate)", () => {
    const first = openCommitment();
    const second = openCommitment();
    expect(second).toBe(first);
    const all = store.connection.sqlite.query("SELECT COUNT(*) AS n FROM commitments").get() as {
      n: number;
    };
    expect(all.n).toBe(1);
  });
});

describe("commitment.list (read)", () => {
  test("filters by state and direction, newest-updated first", () => {
    const a = openCommitment({ title: "owe A", direction: "owed_by_me" });
    const b = openCommitment({ title: "owe B", direction: "owed_to_me" });
    commitmentResolve(store, { commitmentId: a });

    const open = listCommitments(store.connection.sqlite, { state: "open" });
    expect(open.map((c) => c.id)).toEqual([b]);

    const byMe = listCommitments(store.connection.sqlite, { direction: "owed_by_me" });
    expect(byMe.map((c) => c.id)).toEqual([a]);

    const all = listCommitments(store.connection.sqlite);
    expect(all).toHaveLength(2);
  });
});

describe("commitment state machine (resolve / dismiss / reopen)", () => {
  test("resolve: open → resolved, idempotent, invalid from dismissed, missing", () => {
    const id = openCommitment();
    expect(commitmentResolve(store, { commitmentId: id }).status).toBe("resolved");
    expect(commitmentRow(id)?.state).toBe("resolved");
    // Idempotent no-op.
    expect(commitmentResolve(store, { commitmentId: id }).status).toBe("already_resolved");

    const dismissed = openCommitment({ title: "drop me", direction: "owed_to_me" });
    commitmentDismiss(store, { commitmentId: dismissed });
    expect(commitmentResolve(store, { commitmentId: dismissed }).status).toBe("invalid_state");
    expect(commitmentRow(dismissed)?.state).toBe("dismissed");

    expect(commitmentResolve(store, { commitmentId: "cmt_nope" }).status).toBe("missing");
  });

  test("dismiss: open → dismissed, idempotent, invalid from resolved, missing", () => {
    const id = openCommitment();
    expect(commitmentDismiss(store, { commitmentId: id }).status).toBe("dismissed");
    expect(commitmentRow(id)?.state).toBe("dismissed");
    expect(commitmentDismiss(store, { commitmentId: id }).status).toBe("already_dismissed");

    const resolved = openCommitment({ title: "done it", direction: "owed_to_me" });
    commitmentResolve(store, { commitmentId: resolved });
    expect(commitmentDismiss(store, { commitmentId: resolved }).status).toBe("invalid_state");

    expect(commitmentDismiss(store, { commitmentId: "cmt_nope" }).status).toBe("missing");
  });

  test("reopen: resolved/dismissed → open, idempotent on open, missing", () => {
    const id = openCommitment();
    commitmentResolve(store, { commitmentId: id });
    expect(commitmentReopen(store, { commitmentId: id }).status).toBe("reopened");
    expect(commitmentRow(id)?.state).toBe("open");
    // Already open → no-op.
    expect(commitmentReopen(store, { commitmentId: id }).status).toBe("already_open");

    const dismissed = openCommitment({ title: "back from dismiss", direction: "owed_to_me" });
    commitmentDismiss(store, { commitmentId: dismissed });
    expect(commitmentReopen(store, { commitmentId: dismissed }).status).toBe("reopened");
    expect(commitmentRow(dismissed)?.state).toBe("open");

    expect(commitmentReopen(store, { commitmentId: "cmt_nope" }).status).toBe("missing");
  });
});

describe("rebuild idempotence (ADR-0002)", () => {
  test("the commitment state survives a full projection rebuild", () => {
    const a = openCommitment({ title: "resolve me", direction: "owed_by_me" });
    const b = openCommitment({ title: "dismiss me", direction: "owed_to_me" });
    commitmentResolve(store, { commitmentId: a });
    commitmentDismiss(store, { commitmentId: b });

    const before = listCommitments(store.connection.sqlite);
    store.rebuild();
    const after = listCommitments(store.connection.sqlite);
    expect(after).toEqual(before);
    expect(commitmentRow(a)?.state).toBe("resolved");
    expect(commitmentRow(b)?.state).toBe("dismissed");
  });
});
