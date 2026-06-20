/**
 * `source.forget` — local purge + event redaction (ADR-0026). Verifies the
 * source disappears from the projection/FTS/history, the event-log body is
 * redacted, replay keeps it absent (reducer-driven delete), sidecar substrate is
 * purged, and the operation is idempotent / reports missing.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../../src/db/index.ts";
import { sourceForget } from "../../src/forget/source-forget.ts";
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

describe("sourceForget (ADR-0026)", () => {
  test("removes the source from projection, FTS, history and redacts the event body", () => {
    ingest("gh:1", "secret rocket plans");
    expect(getSource(store.connection.sqlite, "gh:1")?.body).toBe("secret rocket plans");
    expect(searchSources(store.connection.sqlite, "rocket").hits).toHaveLength(1);

    const out = sourceForget(store, { externalId: "gh:1", reason: "mis-ingested" });
    expect(out.status).toBe("forgotten");

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
    expect(sourceForget(store, { externalId: "gh:1" }).status).toBe("forgotten");
    expect(sourceForget(store, { externalId: "gh:1" }).status).toBe("already_forgotten");
    expect(sourceForget(store, { externalId: "nope:1" }).status).toBe("missing");
  });
});
