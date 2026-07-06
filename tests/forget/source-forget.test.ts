/**
 * `source.forget` / `source.unforget` — local purge + event redaction + forget
 * tombstone (ADR-0026, R1). Verifies the source disappears from the
 * projection/FTS/history, the event-log body is redacted, replay keeps it absent
 * (reducer-driven delete) and reproduces the tombstone, sidecar substrate is
 * purged, the whole forget is atomic (a mid-forget failure rolls back), and the
 * operation is idempotent / reports missing. Unforget lifts the tombstone.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/db/index.ts";
import { sourceForget, sourceUnforget } from "../../src/forget/source-forget.ts";
import { getSource, listSourceHistory } from "../../src/mcp/queries.ts";
import { searchSources } from "../../src/retrieval/index.ts";

let store: Store;

beforeEach(() => {
  store = Store.open({ path: ":memory:" });
});

afterEach(() => {
  store.close();
});

function ingest(externalId: string, body: string): void {
  store.record({
    type: "SourceObserved",
    externalId,
    sourceType: "github_issue",
    body,
    observedAt: "2026-06-14T00:00:00.000Z",
    fingerprint: externalId,
    meta: {},
  });
}

function eventBodies(externalId: string): string[] {
  return store.connection.sqlite
    .query<{ b: string }, [string]>(
      `SELECT json_extract(payload, '$.body') AS b FROM events
          WHERE type IN ('SourceObserved','SourceBodyUpdated')
            AND json_extract(payload, '$.externalId') = ?`,
    )
    .all(externalId)
    .map((r) => r.b);
}

/** Whether a forget tombstone row exists for an id. */
function isTombstoned(externalId: string): boolean {
  return (
    (store.connection.sqlite
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM forgotten_sources WHERE external_id = ?",
      )
      .get(externalId)?.n ?? 0) > 0
  );
}

/** Count events of a given type (audit-trail assertions). */
function eventCount(type: string): number {
  return (
    store.connection.sqlite
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM events WHERE type = ?")
      .get(type)?.n ?? 0
  );
}

describe("sourceForget (ADR-0026)", () => {
  test("removes the source from projection, FTS, history and redacts the event body", () => {
    ingest("gh:1", "secret rocket plans");
    expect(getSource(store.connection.sqlite, "gh:1")?.body).toBe("secret rocket plans");
    expect(searchSources(store.connection.sqlite, "rocket").hits).toHaveLength(1);

    const out = sourceForget(store, { externalId: "gh:1", reason: "mis-ingested" });
    expect(out.status).toBe("forgotten");
    expect(out.tombstoned).toBe(true);

    // Projection + FTS gone.
    expect(getSource(store.connection.sqlite, "gh:1")).toBeNull();
    expect(searchSources(store.connection.sqlite, "rocket").hits).toHaveLength(0);
    // Event-log body redacted (content-minimization).
    expect(eventBodies("gh:1")).toEqual([""]);
    // History reflects redaction (versions remain but body blank).
    expect(listSourceHistory(store.connection.sqlite, "gh:1").map((v) => v.body)).toEqual([""]);
    // A body-less SourceForgotten audit event exists.
    const forgot = store.connection.sqlite
      .query("SELECT payload FROM events WHERE type = 'SourceForgotten'")
      .all() as { payload: string }[];
    expect(forgot).toHaveLength(1);
    const p = JSON.parse(forgot[0]?.payload ?? "{}");
    expect(p.externalId).toBe("gh:1");
    expect(p.reason).toBe("mis-ingested");
    expect(p.body).toBeUndefined();
  });

  test("replay keeps the forgotten source absent (reducer-driven delete)", () => {
    ingest("gh:1", "to be forgotten");
    ingest("gh:2", "kept");
    sourceForget(store, { externalId: "gh:1" });

    store.rebuild(); // truncate + replay all events

    expect(getSource(store.connection.sqlite, "gh:1")).toBeNull(); // stays gone
    expect(getSource(store.connection.sqlite, "gh:2")?.body).toBe("kept"); // unaffected
  });

  test("is idempotent and reports missing for unknown ids", () => {
    ingest("gh:1", "x");
    const first = sourceForget(store, { externalId: "gh:1" });
    expect(first.status).toBe("forgotten");
    expect(first.tombstoned).toBe(true);

    const again = sourceForget(store, { externalId: "gh:1" });
    expect(again.status).toBe("already_forgotten");
    expect(again.tombstoned).toBe(true);

    const missing = sourceForget(store, { externalId: "nope:1" });
    expect(missing.status).toBe("missing");
    expect(missing.tombstoned).toBe(false);
  });
});

describe("sourceForget — tombstone + atomicity + physical erasure (ADR-0026 R1)", () => {
  test("forget lays a tombstone (R1-1); replay reproduces it", () => {
    ingest("gh:1", "secret");
    expect(isTombstoned("gh:1")).toBe(false);

    sourceForget(store, { externalId: "gh:1" });
    expect(isTombstoned("gh:1")).toBe(true);

    // The tombstone is a projection folded from SourceForgotten — a rebuild must
    // reproduce it (replay-stable), else the next sync could resurrect the source.
    store.rebuild();
    expect(isTombstoned("gh:1")).toBe(true);
  });

  test("a mid-forget failure rolls back the whole operation (single transaction, R1-4)", () => {
    ingest("gh:1", "secret plans");
    // Break the tombstone projection so the SourceForgotten reducer throws while
    // the forget transaction is open — a stand-in for a mid-forget crash.
    store.connection.sqlite.exec("DROP TABLE forgotten_sources");

    expect(() => sourceForget(store, { externalId: "gh:1" })).toThrow();

    // Everything the transaction did before the failure was rolled back: the body
    // is still present in both the projection and the event log, and no audit
    // event was committed. (No half-forgotten state — the atomicity contract.)
    expect(getSource(store.connection.sqlite, "gh:1")?.body).toBe("secret plans");
    expect(eventBodies("gh:1")).toEqual(["secret plans"]);
    expect(eventCount("SourceForgotten")).toBe(0);
  });

  test("forget succeeds on a WAL-mode file db (physical-erasure pragmas are safe, R1-5)", () => {
    // The in-memory store above never exercises WAL; a real file db does. This
    // asserts the secure_delete + wal_checkpoint(TRUNCATE) path runs cleanly and
    // still forgets. (Free-page/WAL contents aren't inspectable here; we verify
    // the operation is correct and non-throwing on the WAL substrate.)
    const dir = mkdtempSync(join(tmpdir(), "suasor-forget-wal-"));
    const fileStore = Store.open({ path: join(dir, "suasor.db") });
    try {
      fileStore.record({
        type: "SourceObserved",
        externalId: "gh:1",
        sourceType: "github_issue",
        body: "secret rocket plans",
        observedAt: "2026-06-14T00:00:00.000Z",
        fingerprint: "gh:1",
        meta: {},
      });
      const out = sourceForget(fileStore, { externalId: "gh:1" });
      expect(out.status).toBe("forgotten");
      expect(getSource(fileStore.connection.sqlite, "gh:1")).toBeNull();
      // secure_delete is restored to OFF (the pre-forget default) afterwards.
      const sd = fileStore.connection.sqlite.query("PRAGMA secure_delete").get() as {
        secure_delete?: number;
      } | null;
      expect(sd?.secure_delete).toBe(0);
    } finally {
      fileStore.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("sourceUnforget — lift the tombstone (ADR-0026 R1-1)", () => {
  test("clears the tombstone and appends SourceUnforgotten", () => {
    ingest("gh:1", "secret");
    sourceForget(store, { externalId: "gh:1" });
    expect(isTombstoned("gh:1")).toBe(true);

    const out = sourceUnforget(store, { externalId: "gh:1" });
    expect(out.status).toBe("unforgotten");
    expect(isTombstoned("gh:1")).toBe(false);
    expect(eventCount("SourceUnforgotten")).toBe(1);
  });

  test("is a no-op for a source that was never forgotten", () => {
    ingest("gh:1", "kept");
    const out = sourceUnforget(store, { externalId: "gh:1" });
    expect(out.status).toBe("not_forgotten");
    expect(eventCount("SourceUnforgotten")).toBe(0);
  });

  test("replay reproduces a forget→unforget as no tombstone", () => {
    ingest("gh:1", "secret");
    sourceForget(store, { externalId: "gh:1" });
    sourceUnforget(store, { externalId: "gh:1" });

    store.rebuild();
    expect(isTombstoned("gh:1")).toBe(false);
  });
});
