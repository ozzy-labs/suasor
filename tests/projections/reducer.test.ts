import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../../src/db/index.ts";
import { identityKey, personIdFor } from "../../src/projections/person.ts";

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

describe("task scheduling fields (ADR-0028)", () => {
  test("TaskProposed folds dueDate / priority onto the projection row", () => {
    const now = new Date("2026-06-14T00:00:00.000Z");
    store.record(
      {
        type: "TaskProposed",
        taskId: "t1",
        title: "ship it",
        dueDate: "2026-06-30T00:00:00.000Z",
        priority: "high",
        sourceExternalIds: [],
      },
      now,
    );
    const task = rows(store, "tasks") as Array<{
      due_date: string | null;
      priority: string | null;
    }>;
    expect(task[0]?.due_date).toBe("2026-06-30T00:00:00.000Z");
    expect(task[0]?.priority).toBe("high");
  });

  test("dueDate / priority default to null when omitted (backward-compatible)", () => {
    store.record(
      { type: "TaskProposed", taskId: "t1", title: "vague", sourceExternalIds: [] },
      new Date("2026-06-14T00:00:00.000Z"),
    );
    const task = rows(store, "tasks") as Array<{
      due_date: string | null;
      priority: string | null;
    }>;
    expect(task[0]?.due_date).toBeNull();
    expect(task[0]?.priority).toBeNull();
  });

  test("TaskApplied with non-null dueDate (re)sets it; null leaves it untouched", () => {
    const now = new Date("2026-06-14T00:00:00.000Z");
    store.record(
      {
        type: "TaskProposed",
        taskId: "t1",
        title: "with due",
        dueDate: "2026-06-30T00:00:00.000Z",
        priority: "normal",
        sourceExternalIds: [],
      },
      now,
    );
    // Advance state only (null scheduling) — existing dueDate / priority preserved.
    store.record({ type: "TaskApplied", taskId: "t1", state: "in_progress" }, now);
    let task = rows(store, "tasks") as Array<{
      state: string;
      due_date: string | null;
      priority: string | null;
    }>;
    expect(task[0]?.state).toBe("in_progress");
    expect(task[0]?.due_date).toBe("2026-06-30T00:00:00.000Z");
    expect(task[0]?.priority).toBe("normal");

    // A non-null dueDate on apply overwrites it.
    store.record(
      {
        type: "TaskApplied",
        taskId: "t1",
        state: "in_progress",
        dueDate: "2026-07-15T00:00:00.000Z",
        priority: "high",
      },
      now,
    );
    task = rows(store, "tasks") as Array<{
      state: string;
      due_date: string | null;
      priority: string | null;
    }>;
    expect(task[0]?.due_date).toBe("2026-07-15T00:00:00.000Z");
    expect(task[0]?.priority).toBe("high");
  });

  test("a legacy TaskProposed event (no dueDate/priority) replays to null (replay-stable)", () => {
    // Simulate a pre-ADR-0028 event row persisted without the scheduling fields.
    const sqlite = store.connection.sqlite;
    const payload = JSON.stringify({
      type: "TaskProposed",
      id: "01OLD",
      recordedAt: "2026-06-14T00:00:00.000Z",
      schemaVersion: 1,
      taskId: "legacy",
      title: "old task",
      sourceExternalIds: [],
    });
    sqlite
      .query(
        "INSERT INTO events (id, type, schema_version, recorded_at, payload) VALUES (?, 'TaskProposed', 1, ?, ?)",
      )
      .run("01OLD", "2026-06-14T00:00:00.000Z", payload);
    // Rebuild from the event log: the missing fields default to null on parse.
    store.rebuild();
    const task = sqlite
      .query("SELECT due_date, priority, title FROM tasks WHERE id = 'legacy'")
      .get() as { due_date: string | null; priority: string | null; title: string };
    expect(task.title).toBe("old task");
    expect(task.due_date).toBeNull();
    expect(task.priority).toBeNull();
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

describe("SyncRunStarted / SyncRunEnded (ADR-0033)", () => {
  type SyncRunRow = {
    connector: string;
    run_id: string;
    started_at: string;
    ended_at: string | null;
    status: string;
    observed: number;
    updated: number;
    unchanged: number;
    duration_ms: number | null;
    last_error: string | null;
  };

  test("SyncRunStarted inserts a running row with cleared outcome fields", () => {
    store.record(
      {
        type: "SyncRunStarted",
        connector: "github",
        runId: "github:2026-06-14T00:00:00.000Z",
        startedAt: "2026-06-14T00:00:00.000Z",
      },
      new Date("2026-06-14T00:00:00.500Z"),
    );
    const runs = rows(store, "sync_runs") as SyncRunRow[];
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("running");
    expect(runs[0]?.ended_at).toBeNull();
    expect(runs[0]?.duration_ms).toBeNull();
  });

  test("SyncRunEnded confirms status / counts / duration on the connector row", () => {
    store.record(
      {
        type: "SyncRunStarted",
        connector: "github",
        runId: "github:r1",
        startedAt: "2026-06-14T00:00:00.000Z",
      },
      new Date("2026-06-14T00:00:00.000Z"),
    );
    store.record(
      {
        type: "SyncRunEnded",
        connector: "github",
        runId: "github:r1",
        status: "ok",
        observed: 3,
        updated: 1,
        unchanged: 7,
        durationMs: 1234,
      },
      new Date("2026-06-14T00:00:02.000Z"),
    );
    const runs = rows(store, "sync_runs") as SyncRunRow[];
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("ok");
    expect(runs[0]?.observed).toBe(3);
    expect(runs[0]?.updated).toBe(1);
    expect(runs[0]?.unchanged).toBe(7);
    expect(runs[0]?.duration_ms).toBe(1234);
    expect(runs[0]?.ended_at).toBe("2026-06-14T00:00:02.000Z");
    expect(runs[0]?.last_error).toBeNull();
  });

  test("a failed run records status=error and the message", () => {
    store.record(
      {
        type: "SyncRunStarted",
        connector: "slack",
        runId: "slack:r1",
        startedAt: "2026-06-14T00:00:00.000Z",
      },
      new Date("2026-06-14T00:00:00.000Z"),
    );
    store.record(
      {
        type: "SyncRunEnded",
        connector: "slack",
        runId: "slack:r1",
        status: "error",
        durationMs: 50,
        error: "token expired",
      },
      new Date("2026-06-14T00:00:00.050Z"),
    );
    const runs = rows(store, "sync_runs") as SyncRunRow[];
    expect(runs[0]?.status).toBe("error");
    expect(runs[0]?.last_error).toBe("token expired");
  });

  test("a later run replaces the connector's latest row (1 row per connector)", () => {
    store.record(
      {
        type: "SyncRunStarted",
        connector: "github",
        runId: "github:r1",
        startedAt: "2026-06-14T00:00:00.000Z",
      },
      new Date("2026-06-14T00:00:00.000Z"),
    );
    store.record(
      {
        type: "SyncRunEnded",
        connector: "github",
        runId: "github:r1",
        status: "error",
        durationMs: 10,
        error: "boom",
      },
      new Date("2026-06-14T00:00:01.000Z"),
    );
    // Second run for the same connector, this time clean.
    store.record(
      {
        type: "SyncRunStarted",
        connector: "github",
        runId: "github:r2",
        startedAt: "2026-06-15T00:00:00.000Z",
      },
      new Date("2026-06-15T00:00:00.000Z"),
    );
    store.record(
      {
        type: "SyncRunEnded",
        connector: "github",
        runId: "github:r2",
        status: "ok",
        observed: 2,
        durationMs: 20,
      },
      new Date("2026-06-15T00:00:01.000Z"),
    );
    const runs = rows(store, "sync_runs") as SyncRunRow[];
    expect(runs).toHaveLength(1);
    expect(runs[0]?.run_id).toBe("github:r2");
    expect(runs[0]?.status).toBe("ok");
    expect(runs[0]?.last_error).toBeNull(); // prior error cleared by the new run
  });

  test("rebuild replays run events to the same latest-run projection", () => {
    store.record(
      {
        type: "SyncRunStarted",
        connector: "github",
        runId: "github:r1",
        startedAt: "2026-06-14T00:00:00.000Z",
      },
      new Date("2026-06-14T00:00:00.000Z"),
    );
    store.record(
      {
        type: "SyncRunEnded",
        connector: "github",
        runId: "github:r1",
        status: "ok",
        observed: 5,
        durationMs: 100,
      },
      new Date("2026-06-14T00:00:01.000Z"),
    );
    const before = rows(store, "sync_runs");
    store.rebuild();
    const after = rows(store, "sync_runs");
    expect(after).toEqual(before);
  });
});

describe("idempotent re-application (no double-update under replay)", () => {
  type SourceRow = { external_id: string; body: string; fingerprint: string };

  test("re-applying the same SourceObserved leaves a single row + single FTS entry", () => {
    const now = new Date("2026-06-14T00:00:00.000Z");
    const event = {
      type: "SourceObserved" as const,
      externalId: "gh:1",
      sourceType: "github_issue",
      body: "deploy the rocket",
      observedAt: "2026-06-14T00:00:00.000Z",
      fingerprint: "fp1",
      meta: {},
    };
    // The reducer is content-keyed (ON CONFLICT(external_id)) so applying the
    // exact same event twice must converge to one row, not duplicate it.
    store.record(event, now);
    store.record(event, now);
    const src = rows(store, "sources") as SourceRow[];
    expect(src).toHaveLength(1);
    expect(src[0]?.body).toBe("deploy the rocket");
    const fts = store.connection.sqlite.query("SELECT external_id FROM sources_fts").all();
    expect(fts).toHaveLength(1);
  });

  test("a stale (out-of-order) SourceObserved still converges via last-writer-wins", () => {
    const now = new Date("2026-06-14T00:00:00.000Z");
    store.record(
      {
        type: "SourceObserved",
        externalId: "gh:1",
        sourceType: "github_issue",
        body: "new body",
        observedAt: "2026-06-15T00:00:00.000Z",
        fingerprint: "fp-new",
        meta: {},
      },
      now,
    );
    // A re-observed (possibly older) payload for the same id overwrites the row;
    // the reducer carries no per-event ordering guard — convergence is the caller's
    // delta-detection job. This documents the last-writer-wins projection contract.
    store.record(
      {
        type: "SourceObserved",
        externalId: "gh:1",
        sourceType: "github_issue",
        body: "older body",
        observedAt: "2026-06-13T00:00:00.000Z",
        fingerprint: "fp-old",
        meta: {},
      },
      now,
    );
    const src = rows(store, "sources") as SourceRow[];
    expect(src).toHaveLength(1);
    expect(src[0]?.body).toBe("older body");
    expect(src[0]?.fingerprint).toBe("fp-old");
  });

  test("re-proposing a task many times never duplicates its provenance link", () => {
    const now = new Date("2026-06-14T00:00:00.000Z");
    for (let i = 0; i < 5; i++) {
      store.record(
        {
          type: "TaskProposed",
          taskId: "t1",
          title: `iteration ${i}`,
          sourceExternalIds: ["gh:1", "gh:2"],
        },
        now,
      );
    }
    const tasks = rows(store, "tasks") as Array<{ title: string }>;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.title).toBe("iteration 4"); // last write wins
    const links = rows(store, "links") as Array<{ to_id: string }>;
    expect(links).toHaveLength(2); // one per distinct source, no dupes
  });
});

describe("invalid / no-op transitions (no fabricated rows)", () => {
  const now = new Date("2026-06-14T00:00:00.000Z");

  test("TaskApplied without a prior TaskProposed fabricates no task row", () => {
    store.record({ type: "TaskApplied", taskId: "ghost", state: "completed" }, now);
    expect(rows(store, "tasks")).toHaveLength(0);
  });

  test("CommitmentResolved / Dismissed / Reopened on a missing commitment is a no-op", () => {
    store.record({ type: "CommitmentResolved", commitmentId: "ghost" }, now);
    store.record({ type: "CommitmentDismissed", commitmentId: "ghost" }, now);
    store.record({ type: "CommitmentReopened", commitmentId: "ghost" }, now);
    expect(rows(store, "commitments")).toHaveLength(0);
  });

  test("ProposalRejected only acts on a pending candidate (applied stays applied)", () => {
    // Generate a candidate, apply it (TaskProposed flips it to applied), then a
    // late reject must NOT downgrade the already-applied proposal.
    store.record(
      {
        type: "ProposalGenerated",
        candidateId: "c1",
        mode: "source_extract",
        kind: "task",
        entityId: "t1",
        summary: "do the thing",
      },
      now,
    );
    store.record(
      { type: "TaskProposed", taskId: "t1", title: "do it", sourceExternalIds: [] },
      now,
    );
    store.record({ type: "ProposalRejected", candidateId: "c1", reason: "too late" }, now);
    const proposal = store.connection.sqlite
      .query<{ state: string }, [string]>("SELECT state FROM proposals WHERE candidate_id = ?")
      .get("c1");
    expect(proposal?.state).toBe("applied"); // not "rejected"
  });

  test("ProposalRejected on a still-pending candidate records the reason", () => {
    store.record(
      {
        type: "ProposalGenerated",
        candidateId: "c2",
        mode: "source_extract",
        kind: "task",
        entityId: "t2",
        summary: "maybe",
      },
      now,
    );
    store.record({ type: "ProposalRejected", candidateId: "c2", reason: "not now" }, now);
    const proposal = store.connection.sqlite
      .query<{ state: string; reason: string }, [string]>(
        "SELECT state, reason FROM proposals WHERE candidate_id = ?",
      )
      .get("c2");
    expect(proposal?.state).toBe("rejected");
    expect(proposal?.reason).toBe("not now");
  });
});

describe("person identity reducer (ADR-0022)", () => {
  const now = new Date("2026-06-14T00:00:00.000Z");

  function observe(connector: string, handle: string, displayName?: string): string {
    const personId = personIdFor(connector, handle);
    store.record(
      {
        type: "PersonIdentityObserved",
        personId,
        connector,
        handle,
        ...(displayName !== undefined ? { displayName } : {}),
      },
      now,
    );
    return personId;
  }

  function personOf(connector: string, handle: string): string | undefined {
    return store.connection.sqlite
      .query<{ person_id: string }, [string]>(
        "SELECT person_id FROM person_identities WHERE identity_key = ?",
      )
      .get(identityKey(connector, handle))?.person_id;
  }

  function person(id: string): { display_name: string; identity_count: number } | null {
    return store.connection.sqlite
      .query<{ display_name: string; identity_count: number }, [string]>(
        "SELECT display_name, identity_count FROM persons WHERE id = ?",
      )
      .get(id);
  }

  test("first observation creates a person with identity_count 1", () => {
    const id = observe("github", "octocat", "Octo Cat");
    expect(person(id)).toEqual({ display_name: "Octo Cat", identity_count: 1 });
  });

  test("re-observing an existing identity with a new display name updates it without re-pointing", () => {
    // Covers the `else if (name !== "")` branch: the identity keeps its person,
    // but the latest non-empty display name lands on both identity + person.
    const id = observe("github", "octocat", "Old Name");
    observe("github", "octocat", "New Name");
    expect(personOf("github", "octocat")).toBe(id); // not re-pointed
    expect(person(id)?.display_name).toBe("New Name");
    const identityName = store.connection.sqlite
      .query<{ display_name: string }, [string]>(
        "SELECT display_name FROM person_identities WHERE identity_key = ?",
      )
      .get(identityKey("github", "octocat"))?.display_name;
    expect(identityName).toBe("New Name");
    expect(person(id)?.identity_count).toBe(1); // still one identity
  });

  test("re-observing with an empty display name leaves the prior name intact", () => {
    const id = observe("github", "octocat", "Keep Me");
    observe("github", "octocat"); // no displayName → empty string branch skipped
    expect(person(id)?.display_name).toBe("Keep Me");
  });

  test("PersonsMerged rewrites identity ownership and refreshes both counts", () => {
    const gh = observe("github", "octocat");
    const slack = observe("slack", "U1");
    store.record({ type: "PersonsMerged", targetPersonId: gh, sourcePersonId: slack }, now);
    expect(personOf("slack", "U1")).toBe(gh);
    expect(person(gh)?.identity_count).toBe(2);
    expect(person(slack)?.identity_count).toBe(0); // emptied, row retained for audit
  });

  test("a self-merge (source == target) is a guarded no-op", () => {
    const gh = observe("github", "octocat");
    store.record({ type: "PersonsMerged", targetPersonId: gh, sourcePersonId: gh }, now);
    expect(person(gh)?.identity_count).toBe(1);
  });

  test("re-applying a PersonsMerged is a no-op (idempotent under replay)", () => {
    const gh = observe("github", "octocat");
    const slack = observe("slack", "U1");
    store.record({ type: "PersonsMerged", targetPersonId: gh, sourcePersonId: slack }, now);
    store.record({ type: "PersonsMerged", targetPersonId: gh, sourcePersonId: slack }, now);
    expect(person(gh)?.identity_count).toBe(2);
    expect(person(slack)?.identity_count).toBe(0);
  });

  test("PersonSplit moves an identity to a new person and refreshes both counts", () => {
    const gh = observe("github", "octocat");
    const slack = observe("slack", "U1");
    store.record({ type: "PersonsMerged", targetPersonId: gh, sourcePersonId: slack }, now);
    // Split the slack identity back out to a fresh person.
    store.record(
      { type: "PersonSplit", newPersonId: slack, connector: "slack", handle: "U1" },
      now,
    );
    expect(personOf("slack", "U1")).toBe(slack);
    expect(person(gh)?.identity_count).toBe(1);
    expect(person(slack)?.identity_count).toBe(1);
  });

  test("PersonSplit of an unknown identity is a no-op", () => {
    store.record(
      { type: "PersonSplit", newPersonId: "person_new", connector: "slack", handle: "ghost" },
      now,
    );
    expect(personOf("slack", "ghost")).toBeUndefined();
    expect(person("person_new")).toBeNull();
  });

  test("PersonSplit that resolves to the same person is a no-op", () => {
    const gh = observe("github", "octocat");
    // newPersonId equals the identity's current person → early return.
    store.record(
      { type: "PersonSplit", newPersonId: gh, connector: "github", handle: "octocat" },
      now,
    );
    expect(personOf("github", "octocat")).toBe(gh);
    expect(person(gh)?.identity_count).toBe(1);
  });

  test("identity ownership survives a full rebuild (merge is replay-stable)", () => {
    const gh = observe("github", "octocat");
    const slack = observe("slack", "U1");
    store.record({ type: "PersonsMerged", targetPersonId: gh, sourcePersonId: slack }, now);
    store.rebuild();
    expect(personOf("slack", "U1")).toBe(gh);
    expect(person(gh)?.identity_count).toBe(2);
    expect(person(slack)?.identity_count).toBe(0);
  });
});

describe("SlackChannelObserved (ADR-0037 §3)", () => {
  const now = new Date("2026-07-01T00:00:00.000Z");

  /** The single slack_channels row for a channel id, or undefined. */
  function channel(channelId: string) {
    return store.connection.sqlite
      .query<
        { channel_id: string; team_id: string; name: string; kind: string; observed_at: string },
        [string]
      >("SELECT * FROM slack_channels WHERE channel_id = ?")
      .get(channelId);
  }

  test("inserts a channel row (name + kind + team + observed_at)", () => {
    store.record(
      {
        type: "SlackChannelObserved",
        channelId: "C1",
        teamId: "T1",
        displayName: "general",
        kind: "public",
      },
      now,
    );
    expect(channel("C1")).toEqual({
      channel_id: "C1",
      team_id: "T1",
      name: "general",
      kind: "public",
      observed_at: now.toISOString(),
    });
  });

  test("a degrade insert (no displayName) stores an empty name → id fallback", () => {
    store.record(
      { type: "SlackChannelObserved", channelId: "C9", teamId: "T1", kind: "public" },
      now,
    );
    expect(channel("C9")?.name).toBe("");
  });

  test("re-observe is last-write-wins on name / kind / observed_at (rename追従, §7)", () => {
    store.record(
      {
        type: "SlackChannelObserved",
        channelId: "C1",
        teamId: "T1",
        displayName: "general",
        kind: "public",
      },
      now,
    );
    const later = new Date("2026-07-02T00:00:00.000Z");
    store.record(
      {
        type: "SlackChannelObserved",
        channelId: "C1",
        teamId: "T1",
        displayName: "renamed",
        kind: "private",
      },
      later,
    );
    const row = channel("C1");
    expect(row?.name).toBe("renamed");
    expect(row?.kind).toBe("private");
    expect(row?.observed_at).toBe(later.toISOString());
  });

  test("a degrade re-observe (empty name) keeps the prior non-empty name (§6/§7)", () => {
    store.record(
      {
        type: "SlackChannelObserved",
        channelId: "C1",
        teamId: "T1",
        displayName: "general",
        kind: "public",
      },
      now,
    );
    // Later scope-degraded sync: no displayName. Must NOT blank the resolved name,
    // but kind / observed_at still refresh (last-write-wins on those columns).
    const later = new Date("2026-07-03T00:00:00.000Z");
    store.record(
      { type: "SlackChannelObserved", channelId: "C1", teamId: "T1", kind: "private" },
      later,
    );
    const row = channel("C1");
    expect(row?.name).toBe("general"); // preserved
    expect(row?.kind).toBe("private"); // refreshed
    expect(row?.observed_at).toBe(later.toISOString());
  });

  test("kinds cover dm / group and survive a full rebuild (replay-stable)", () => {
    store.record(
      {
        type: "SlackChannelObserved",
        channelId: "D1",
        teamId: "T1",
        displayName: "Ada",
        kind: "dm",
      },
      now,
    );
    store.record(
      {
        type: "SlackChannelObserved",
        channelId: "G1",
        teamId: "T1",
        displayName: "Ada, Grace",
        kind: "group",
      },
      now,
    );
    store.rebuild();
    expect(channel("D1")).toMatchObject({ name: "Ada", kind: "dm" });
    expect(channel("G1")).toMatchObject({ name: "Ada, Grace", kind: "group" });
  });
});

describe("SlackTeamObserved (ADR-0037 §10, Issue #361)", () => {
  const now = new Date("2026-07-01T00:00:00.000Z");

  /** The single slack_teams row for a team id, or undefined. */
  function team(teamId: string) {
    return store.connection.sqlite
      .query<{ team_id: string; name: string; observed_at: string }, [string]>(
        "SELECT * FROM slack_teams WHERE team_id = ?",
      )
      .get(teamId);
  }

  test("inserts a team row (name + observed_at)", () => {
    store.record({ type: "SlackTeamObserved", teamId: "T1", displayName: "Acme" }, now);
    expect(team("T1")).toEqual({
      team_id: "T1",
      name: "Acme",
      observed_at: now.toISOString(),
    });
  });

  test("a degrade insert (no displayName) stores an empty name → id fallback", () => {
    store.record({ type: "SlackTeamObserved", teamId: "T9" }, now);
    expect(team("T9")?.name).toBe("");
  });

  test("re-observe is last-write-wins on name / observed_at (rename追従, §7)", () => {
    store.record({ type: "SlackTeamObserved", teamId: "T1", displayName: "Acme" }, now);
    const later = new Date("2026-07-02T00:00:00.000Z");
    store.record({ type: "SlackTeamObserved", teamId: "T1", displayName: "Acme Corp" }, later);
    const row = team("T1");
    expect(row?.name).toBe("Acme Corp");
    expect(row?.observed_at).toBe(later.toISOString());
  });

  test("a degrade re-observe (empty name) keeps the prior non-empty name (§6/§7)", () => {
    store.record({ type: "SlackTeamObserved", teamId: "T1", displayName: "Acme" }, now);
    // Later scope-degraded sync: no displayName. Must NOT blank the resolved name,
    // but observed_at still refreshes (last-write-wins on that column).
    const later = new Date("2026-07-03T00:00:00.000Z");
    store.record({ type: "SlackTeamObserved", teamId: "T1" }, later);
    const row = team("T1");
    expect(row?.name).toBe("Acme"); // preserved
    expect(row?.observed_at).toBe(later.toISOString()); // refreshed
  });

  test("survives a full rebuild (replay-stable, §9)", () => {
    store.record({ type: "SlackTeamObserved", teamId: "T1", displayName: "Acme" }, now);
    store.rebuild();
    expect(team("T1")).toMatchObject({ team_id: "T1", name: "Acme" });
  });
});
