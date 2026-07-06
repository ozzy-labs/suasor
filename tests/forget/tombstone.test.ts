/**
 * Forget tombstone ⇄ sync integration (ADR-0026 R1-1). The acceptance condition:
 * a source that still exists upstream, once forgotten, must NOT be resurrected by
 * the next (cron-equivalent) sync — and `source.unforget` must re-allow ingest.
 *
 * These pin the regression the R1 revision closes: before the tombstone, ingest
 * judged novelty purely on the absence of a `sources` row, so forget (which
 * deletes that row) left the source looking brand-new and the next sync
 * re-observed the full body (`src/connectors/sync.ts` fingerprint path).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  Connector,
  SourceRecord,
  SyncContext,
  SyncResult,
} from "../../src/connectors/contract.ts";
import { syncConnector } from "../../src/connectors/index.ts";
import { Store } from "../../src/db/index.ts";
import { sourceForget, sourceUnforget } from "../../src/forget/source-forget.ts";
import { getSource } from "../../src/mcp/queries.ts";

let store: Store;

beforeEach(() => {
  store = Store.open({ path: ":memory:" });
});

afterEach(() => {
  store.close();
});

/** A fake connector that re-emits a fixed set of records on every sync pass. */
function fakeConnector(records: SourceRecord[]): Connector {
  return {
    name: "fake",
    sourceType: "fake",
    async *sync(_ctx: SyncContext): AsyncIterable<SourceRecord> {
      for (const r of records) yield r;
    },
    finalize(): SyncResult {
      return { cursor: null };
    },
  };
}

const rec = (id: string, body: string): SourceRecord => ({
  externalId: id,
  sourceType: "github_issue",
  body,
  observedAt: "2026-06-14T00:00:00.000Z",
  meta: {},
});

describe("forget tombstone blocks resurrection on the next sync (ADR-0026 R1-1)", () => {
  test("a forgotten source that remains upstream is not re-ingested", async () => {
    // 1. Ingest the source, then forget it.
    await syncConnector(store, fakeConnector([rec("gh:1", "secret rocket plans")]));
    expect(getSource(store.connection.sqlite, "gh:1")?.body).toBe("secret rocket plans");
    sourceForget(store, { externalId: "gh:1" });
    expect(getSource(store.connection.sqlite, "gh:1")).toBeNull();

    // 2. The upstream still yields the record (cron-equivalent sync). The
    //    tombstone must skip it — nothing observed, source stays gone.
    const out = await syncConnector(store, fakeConnector([rec("gh:1", "secret rocket plans")]));
    expect(out).toMatchObject({ observed: 0, updated: 0, unchanged: 0 });
    expect(getSource(store.connection.sqlite, "gh:1")).toBeNull();

    // 3. No new SourceObserved/SourceBodyUpdated body leaked back into the log.
    const bodies = store.connection.sqlite
      .query<{ b: string }, [string]>(
        `SELECT json_extract(payload, '$.body') AS b FROM events
            WHERE type IN ('SourceObserved','SourceBodyUpdated')
              AND json_extract(payload, '$.externalId') = ?`,
      )
      .all("gh:1")
      .map((r) => r.b);
    expect(bodies).toEqual([""]); // the single redacted original, nothing new
  });

  test("the tombstone is scoped to the forgotten id (others still ingest)", async () => {
    await syncConnector(store, fakeConnector([rec("gh:1", "forget me"), rec("gh:2", "keep me")]));
    sourceForget(store, { externalId: "gh:1" });

    const out = await syncConnector(
      store,
      fakeConnector([rec("gh:1", "forget me"), rec("gh:2", "keep me")]),
    );
    // gh:2 is unchanged (fingerprint match), gh:1 is skipped by the tombstone.
    expect(out).toMatchObject({ observed: 0, updated: 0, unchanged: 1 });
    expect(getSource(store.connection.sqlite, "gh:1")).toBeNull();
    expect(getSource(store.connection.sqlite, "gh:2")?.body).toBe("keep me");
  });

  test("unforget lifts the tombstone so the next sync re-ingests", async () => {
    await syncConnector(store, fakeConnector([rec("gh:1", "secret rocket plans")]));
    sourceForget(store, { externalId: "gh:1" });

    // A sync while tombstoned still does nothing.
    let out = await syncConnector(store, fakeConnector([rec("gh:1", "secret rocket plans")]));
    expect(out.observed).toBe(0);
    expect(getSource(store.connection.sqlite, "gh:1")).toBeNull();

    // Lift the tombstone → the source is re-observed as new on the next sync.
    expect(sourceUnforget(store, { externalId: "gh:1" }).status).toBe("unforgotten");
    out = await syncConnector(store, fakeConnector([rec("gh:1", "secret rocket plans")]));
    expect(out.observed).toBe(1);
    expect(getSource(store.connection.sqlite, "gh:1")?.body).toBe("secret rocket plans");
  });
});
