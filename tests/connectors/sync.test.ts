import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  Connector,
  SourceRecord,
  SyncContext,
  SyncResult,
} from "../../src/connectors/contract.ts";
import { lastCursor, syncConnector } from "../../src/connectors/index.ts";
import { Store } from "../../src/db/index.ts";

let store: Store;

beforeEach(() => {
  store = Store.open({ path: ":memory:" });
});

afterEach(() => {
  store.close();
});

/** A fake connector that emits a fixed set of records and an optional cursor. */
function fakeConnector(
  records: SourceRecord[],
  opts: {
    name?: string;
    cursor?: string | null;
    onCtx?: (ctx: SyncContext) => void | Promise<void>;
  } = {},
): Connector {
  return {
    name: opts.name ?? "fake",
    sourceType: opts.name ?? "fake",
    async *sync(ctx: SyncContext): AsyncIterable<SourceRecord> {
      await opts.onCtx?.(ctx);
      for (const r of records) yield r;
    },
    finalize(): SyncResult {
      return { cursor: opts.cursor ?? null };
    },
  };
}

const rec = (id: string, body: string, fp?: string): SourceRecord => ({
  externalId: id,
  sourceType: "github_issue",
  body,
  observedAt: "2026-06-14T00:00:00.000Z",
  meta: { k: "v" },
  ...(fp ? { fingerprint: fp } : {}),
});

function sourceBody(id: string): string | undefined {
  const row = store.connection.sqlite
    .query<{ body: string }, [string]>("SELECT body FROM sources WHERE external_id = ?")
    .get(id);
  return row?.body;
}

describe("syncConnector — observe / update / unchanged (FR-ING-3)", () => {
  test("first run observes all records and writes sources + FTS", async () => {
    const out = await syncConnector(store, fakeConnector([rec("gh:1", "deploy the rocket")]));
    expect(out).toMatchObject({ connector: "fake", observed: 1, updated: 0, unchanged: 0 });
    expect(sourceBody("gh:1")).toBe("deploy the rocket");

    const hits = store.connection.sqlite
      .query("SELECT external_id FROM sources_fts WHERE sources_fts MATCH ?")
      .all('"rocket"');
    expect(hits).toHaveLength(1);
  });

  test("re-run with identical bodies skips everything (idempotent)", async () => {
    const records = [rec("gh:1", "alpha body"), rec("gh:2", "beta body")];
    await syncConnector(store, fakeConnector(records));
    const out = await syncConnector(store, fakeConnector(records));
    expect(out).toMatchObject({ observed: 0, updated: 0, unchanged: 2 });
  });

  test("changed body emits SourceBodyUpdated (delta via fingerprint)", async () => {
    await syncConnector(store, fakeConnector([rec("gh:1", "before")]));
    const out = await syncConnector(store, fakeConnector([rec("gh:1", "after")]));
    expect(out).toMatchObject({ observed: 0, updated: 1, unchanged: 0 });
    expect(sourceBody("gh:1")).toBe("after");
  });

  test("connector-supplied fingerprint drives delta even if body is unchanged", async () => {
    await syncConnector(store, fakeConnector([rec("gh:1", "same", "fp-1")]));
    const same = await syncConnector(store, fakeConnector([rec("gh:1", "same", "fp-1")]));
    expect(same.unchanged).toBe(1);
    const bumped = await syncConnector(store, fakeConnector([rec("gh:1", "same", "fp-2")]));
    expect(bumped.updated).toBe(1);
  });
});

describe("syncConnector — cursor resume", () => {
  test("ConnectorSyncCompleted persists the cursor and is read back", async () => {
    await syncConnector(store, fakeConnector([rec("gh:1", "x")], { cursor: "cur-1" }));
    expect(lastCursor(store.connection.sqlite, "fake")).toBe("cur-1");
  });

  test("subsequent run resumes from the last persisted cursor", async () => {
    await syncConnector(store, fakeConnector([rec("gh:1", "x")], { cursor: "cur-1" }));
    let seen: string | null = "unset";
    await syncConnector(
      store,
      fakeConnector([], {
        cursor: "cur-2",
        onCtx: (ctx) => {
          seen = ctx.cursor;
        },
      }),
    );
    expect(seen).toBe("cur-1");
  });

  test("explicit cursor:null forces a full re-scan (ignores saved cursor)", async () => {
    await syncConnector(store, fakeConnector([rec("gh:1", "x")], { cursor: "cur-1" }));
    let seen: string | null = "unset";
    await syncConnector(
      store,
      fakeConnector([], {
        onCtx: (ctx) => {
          seen = ctx.cursor;
        },
      }),
      { cursor: null },
    );
    expect(seen).toBeNull();
  });
});

describe("syncConnector — secret resolution wiring", () => {
  test("ctx.secret resolves the injected env override for the connector", async () => {
    let token: string | null = "unset";
    await syncConnector(
      store,
      fakeConnector([], {
        name: "github",
        onCtx: async (ctx) => {
          token = await ctx.secret("token");
        },
      }),
      { secrets: { env: { SUASOR_CONNECTOR_GITHUB_TOKEN: "tok-xyz" } } },
    );
    expect(token).toBe("tok-xyz");
  });
});

describe("syncConnector — run history (ADR-0033)", () => {
  type SyncRunRow = {
    connector: string;
    status: string;
    observed: number;
    updated: number;
    unchanged: number;
    last_error: string | null;
    ended_at: string | null;
  };

  function syncRun(connector: string): SyncRunRow | null {
    return store.connection.sqlite
      .query<SyncRunRow, [string]>("SELECT * FROM sync_runs WHERE connector = ?")
      .get(connector);
  }

  test("a successful pass records a SyncRunEnded(status=ok) with counts", async () => {
    await syncConnector(store, fakeConnector([rec("gh:1", "x"), rec("gh:2", "y")]));
    const row = syncRun("fake");
    expect(row?.status).toBe("ok");
    expect(row?.observed).toBe(2);
    expect(row?.ended_at).not.toBeNull();
    // Both SyncRunStarted and SyncRunEnded are appended (1 run = 2 history events).
    const counts = store.connection.sqlite
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM events WHERE type = ?")
      .get("SyncRunStarted");
    expect(counts?.n).toBe(1);
  });

  test("a throwing connector still records SyncRunEnded(status=error) and re-throws", async () => {
    const boom: Connector = {
      name: "fake",
      sourceType: "fake",
      // biome-ignore lint/correctness/useYield: intentional throw before yielding.
      async *sync(): AsyncIterable<SourceRecord> {
        throw new Error("upstream 500");
      },
      finalize(): SyncResult {
        return { cursor: null };
      },
    };
    await expect(syncConnector(store, boom)).rejects.toThrow("upstream 500");
    const row = syncRun("fake");
    expect(row?.status).toBe("error");
    expect(row?.last_error).toBe("upstream 500");
  });
});
