import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../../src/db/index.ts";
import { inboxAdd } from "../../src/propose/inbox-add.ts";
import { inboxTriage, TriageError } from "../../src/propose/inbox-triage.ts";

let store: Store;

beforeEach(() => {
  store = Store.open({ path: ":memory:" });
});

afterEach(() => {
  store.close();
});

/** Capture an inbox item and return its id (open). */
function seedItem(sourceExternalId = "gh:1"): string {
  return inboxAdd(store, { sourceExternalId }).inboxId;
}

function inboxState(id: string): string | undefined {
  const row = store.connection.sqlite.query("SELECT state FROM inbox WHERE id = ?").get(id) as {
    state: string;
  } | null;
  return row?.state;
}

function tasks() {
  return store.connection.sqlite.query("SELECT id, title FROM tasks").all() as Array<{
    id: string;
    title: string;
  }>;
}

function decisions() {
  return store.connection.sqlite
    .query("SELECT id, title, rationale FROM decisions")
    .all() as Array<{ id: string; title: string; rationale: string }>;
}

describe("inbox.triage (state machine, #88)", () => {
  test("action=task creates a task from the source and marks item done", () => {
    const id = seedItem("gh:1");
    const out = inboxTriage(store, { inboxId: id, action: "task", title: "follow up" });
    expect(out.action).toBe("task");
    expect(out.state).toBe("done");
    expect(inboxState(id)).toBe("done");
    const t = tasks();
    expect(t).toHaveLength(1);
    expect(t[0]?.title).toBe("follow up");
    expect(t[0]?.id).toBe(out.createdEntityId);
    // Provenance: the created task derives from the inbox item's source.
    const links = store.connection.sqlite
      .query(
        "SELECT to_id FROM links WHERE from_kind = 'task' AND from_id = ? AND relation = 'derived_from'",
      )
      .all(out.createdEntityId as string) as Array<{ to_id: string }>;
    expect(links.map((l) => l.to_id)).toEqual(["gh:1"]);
  });

  test("action=decision creates a decision and marks item done", () => {
    const id = seedItem("gh:2");
    const out = inboxTriage(store, {
      inboxId: id,
      action: "decision",
      title: "go with plan B",
      rationale: "lower risk",
    });
    expect(out.state).toBe("done");
    expect(inboxState(id)).toBe("done");
    const d = decisions();
    expect(d).toHaveLength(1);
    expect(d[0]?.title).toBe("go with plan B");
    expect(d[0]?.rationale).toBe("lower risk");
    expect(d[0]?.id).toBe(out.createdEntityId);
  });

  test("action=discard marks item dismissed without creating an entity", () => {
    const id = seedItem("gh:3");
    const out = inboxTriage(store, { inboxId: id, action: "discard" });
    expect(out.action).toBe("discard");
    expect(out.state).toBe("dismissed");
    expect(out.createdEntityId).toBeUndefined();
    expect(inboxState(id)).toBe("dismissed");
    expect(tasks()).toHaveLength(0);
    expect(decisions()).toHaveLength(0);
  });

  test("rejects triaging a non-existent inbox item", () => {
    expect(() => inboxTriage(store, { inboxId: "inbox_missing", action: "discard" })).toThrow(
      TriageError,
    );
  });

  test("rejects re-triaging an item already moved out of open", () => {
    const id = seedItem("gh:4");
    inboxTriage(store, { inboxId: id, action: "discard" });
    // Already `dismissed` → any further triage is an invalid transition.
    expect(() => inboxTriage(store, { inboxId: id, action: "task", title: "x" })).toThrow(
      TriageError,
    );
    expect(() => inboxTriage(store, { inboxId: id, action: "discard" })).toThrow(TriageError);
  });

  test("task/decision actions require a title (runtime superRefine)", () => {
    const id = seedItem("gh:5");
    // `title` is optional at the type level; the superRefine enforces it at runtime.
    expect(() => inboxTriage(store, { inboxId: id, action: "task" })).toThrow();
    expect(() => inboxTriage(store, { inboxId: id, action: "decision" })).toThrow();
    // Item stays open since both attempts were rejected before any state change.
    expect(inboxState(id)).toBe("open");
  });

  test("rejects an unknown action", () => {
    const id = seedItem("gh:6");
    // @ts-expect-error — 'snooze' is not a triage action.
    expect(() => inboxTriage(store, { inboxId: id, action: "snooze" })).toThrow();
  });
});
