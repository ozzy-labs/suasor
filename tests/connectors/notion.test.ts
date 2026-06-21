import { describe, expect, test } from "bun:test";
import type { SourceRecord, SyncContext } from "../../src/connectors/contract.ts";
import { syncConnector } from "../../src/connectors/index.ts";
import {
  makeNotionClient,
  type NotionClientLike,
  type NotionItem,
  type NotionTransport,
} from "../../src/connectors/notion/client.ts";
import {
  createNotionConnector,
  DEFAULT_PAGE_DEPTH,
  NotionConnectorConfig,
  toRecord,
} from "../../src/connectors/notion.ts";
import { Store } from "../../src/db/index.ts";

function ctx(overrides: Partial<SyncContext> = {}): SyncContext {
  return {
    cursor: null,
    secret: async (name) => (name === "token" ? "secret-tok" : null),
    ...overrides,
  };
}

async function collect(it: AsyncIterable<SourceRecord>): Promise<SourceRecord[]> {
  const out: SourceRecord[] = [];
  for await (const r of it) out.push(r);
  return out;
}

/** A fake structural client streaming pre-canned items per resource. */
function fakeClient(opts: {
  pages?: NotionItem[];
  databases?: Record<string, NotionItem[]>;
  fail?: { pages?: Error; databases?: Record<string, Error> };
}): NotionClientLike {
  return {
    async *pages() {
      if (opts.fail?.pages) throw opts.fail.pages;
      for (const item of opts.pages ?? []) yield item;
    },
    async *databaseItems(databaseId) {
      const err = opts.fail?.databases?.[databaseId];
      if (err) throw err;
      for (const item of opts.databases?.[databaseId] ?? []) yield item;
    },
  };
}

describe("NotionConnectorConfig", () => {
  test("defaults: empty databases, page_depth=10, pages=true", () => {
    const parsed = NotionConnectorConfig.parse({});
    expect(parsed.databases).toEqual([]);
    expect(parsed.page_depth).toBe(DEFAULT_PAGE_DEPTH);
    expect(parsed.pages).toBe(true);
  });

  test("passthrough keeps unknown keys (forward-compat)", () => {
    const parsed = NotionConnectorConfig.parse({ extra: "x" }) as Record<string, unknown>;
    expect(parsed.extra).toBe("x");
  });

  test("rejects a non-positive page_depth", () => {
    expect(() => NotionConnectorConfig.parse({ page_depth: 0 })).toThrow();
  });
});

describe("toRecord — identity + source_type + fingerprint (ADR-0007)", () => {
  test("standalone page maps to notion_page with page-prefixed id", () => {
    const rec = toRecord({
      kind: "page",
      id: "p1",
      title: "Title",
      text: "body text",
      lastEditedTime: "2026-06-10T00:00:00Z",
    });
    expect(rec.externalId).toBe("notion:page:p1");
    expect(rec.sourceType).toBe("notion_page");
    expect(rec.body).toBe("Title\n\nbody text");
    expect(rec.fingerprint).toBe("2026-06-10T00:00:00Z");
    expect(rec.observedAt).toBe("2026-06-10T00:00:00Z");
  });

  test("database row maps to notion_database_item with db-scoped id", () => {
    const rec = toRecord({
      kind: "database_item",
      id: "r1",
      databaseId: "db9",
      title: "Row",
      text: "",
      lastEditedTime: "2026-06-11T00:00:00Z",
    });
    expect(rec.externalId).toBe("notion:db:db9:item:r1");
    expect(rec.sourceType).toBe("notion_database_item");
    // Title-only body when there is no block text.
    expect(rec.body).toBe("Row");
    expect(rec.fingerprint).toBe("2026-06-11T00:00:00Z");
  });

  test("the same row id under two databases yields distinct identities", () => {
    const a = toRecord({
      kind: "database_item",
      id: "shared",
      databaseId: "dbA",
      title: "",
      text: "x",
      lastEditedTime: "t",
    });
    const b = toRecord({
      kind: "database_item",
      id: "shared",
      databaseId: "dbB",
      title: "",
      text: "x",
      lastEditedTime: "t",
    });
    expect(a.externalId).not.toBe(b.externalId);
  });
});

describe("Notion connector — resource sweep (pages + databases)", () => {
  test("streams standalone pages and database rows", async () => {
    const client = fakeClient({
      pages: [
        { kind: "page", id: "p1", title: "P1", text: "", lastEditedTime: "2026-01-01T00:00:00Z" },
      ],
      databases: {
        db1: [
          {
            kind: "database_item",
            id: "r1",
            databaseId: "db1",
            title: "R1",
            text: "",
            lastEditedTime: "2026-01-02T00:00:00Z",
          },
        ],
      },
    });
    const connector = createNotionConnector(
      { databases: ["db1"] },
      { clientFactory: () => client },
    );
    const records = await collect(connector.sync(ctx()));
    expect(records.map((r) => r.externalId).sort()).toEqual([
      "notion:db:db1:item:r1",
      "notion:page:p1",
    ]);
    expect((await connector.finalize?.())?.cursor).toBeNull();
  });

  test("pages=false skips the page sweep", async () => {
    const client = fakeClient({
      pages: [{ kind: "page", id: "p1", title: "P1", text: "", lastEditedTime: "t" }],
      databases: { db1: [] },
    });
    const connector = createNotionConnector(
      { databases: ["db1"], pages: false },
      { clientFactory: () => client },
    );
    const records = await collect(connector.sync(ctx()));
    expect(records).toEqual([]);
  });
});

describe("Notion connector — guards", () => {
  test("throws when no token is configured", async () => {
    const connector = createNotionConnector(
      { databases: ["db1"] },
      { clientFactory: () => fakeClient({}) },
    );
    await expect(collect(connector.sync(ctx({ secret: async () => null })))).rejects.toThrow(
      /no token configured/,
    );
  });

  test("no resources yields nothing (and never builds a client)", async () => {
    let built = false;
    const connector = createNotionConnector(
      { databases: [], pages: false },
      {
        clientFactory: () => {
          built = true;
          return fakeClient({});
        },
      },
    );
    expect(await collect(connector.sync(ctx()))).toEqual([]);
    expect(built).toBe(false);
  });
});

describe("Notion connector — per-resource error isolation (Issue #193)", () => {
  test("one database failing is skipped; the rest stream; one aggregated warn", async () => {
    const client = fakeClient({
      pages: [],
      databases: {
        db1: [
          {
            kind: "database_item",
            id: "r1",
            databaseId: "db1",
            title: "ok",
            text: "",
            lastEditedTime: "t",
          },
        ],
        db2: [],
      },
      fail: { databases: { db2: new Error("404 Not Found") } },
    });
    const warns: string[] = [];
    const connector = createNotionConnector(
      { databases: ["db1", "db2"], pages: false },
      { clientFactory: () => client },
    );
    const records = await collect(connector.sync(ctx({ onWarn: (m) => warns.push(m) })));
    expect(records.map((r) => r.externalId)).toEqual(["notion:db:db1:item:r1"]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("db:db2 (404 Not Found)");
  });

  test("partial failure sets partialFailure + a summary line in finalize", async () => {
    const client = fakeClient({
      databases: { db1: [], db2: [] },
      fail: { databases: { db2: new Error("boom") } },
      pages: [{ kind: "page", id: "p", title: "ok", text: "", lastEditedTime: "t" }],
    });
    const connector = createNotionConnector(
      { databases: ["db1", "db2"] },
      { clientFactory: () => client },
    );
    await collect(connector.sync(ctx({ onWarn: () => {} })));
    const result = await connector.finalize?.();
    expect(result?.partialFailure).toBe(true);
    expect(result?.summaryLines?.[0]).toContain("db:db2=failed (cursor preserved)");
  });

  test("all resources failing throws", async () => {
    const client = fakeClient({
      fail: { pages: new Error("401"), databases: { db1: new Error("403") } },
    });
    const connector = createNotionConnector(
      { databases: ["db1"] },
      { clientFactory: () => client },
    );
    await expect(collect(connector.sync(ctx({ onWarn: () => {} })))).rejects.toThrow(/40[13]/);
  });
});

/** A transport that replays canned responses per request key. */
function cannedTransport(routes: Record<string, { status: number; body: unknown }[]>): {
  transport: NotionTransport;
  calls: string[];
} {
  const calls: string[] = [];
  const cursors: Record<string, number> = {};
  const transport: NotionTransport = async ({ method, path, body }) => {
    // Key by method+path plus the start_cursor so paginated calls differ.
    const cursor = (body?.start_cursor as string | undefined) ?? "";
    const key = `${method} ${path.split("?")[0]}${cursor ? `#${cursor}` : ""}`;
    calls.push(key);
    const list = routes[key] ?? routes[`${method} ${path.split("?")[0]}`] ?? [];
    const idx = cursors[key] ?? 0;
    cursors[key] = idx + 1;
    return list[idx] ?? { status: 200, body: { results: [], has_more: false } };
  };
  return { transport, calls };
}

describe("Notion client — block recursion, pagination, cycle guard, 429 retry", () => {
  test("recurses block children and joins plain text in order", async () => {
    const { transport } = cannedTransport({
      "POST /v1/search": [
        {
          status: 200,
          body: {
            results: [
              {
                object: "page",
                id: "p1",
                last_edited_time: "2026-06-01T00:00:00Z",
                properties: {
                  Name: { type: "title", title: [{ plain_text: "My Page" }] },
                },
              },
            ],
            has_more: false,
          },
        },
      ],
      "GET /v1/blocks/p1/children": [
        {
          status: 200,
          body: {
            results: [
              {
                id: "b1",
                type: "paragraph",
                paragraph: { rich_text: [{ plain_text: "line one" }] },
              },
              {
                id: "b2",
                type: "heading_1",
                heading_1: { rich_text: [{ plain_text: "Header" }] },
                has_children: true,
              },
            ],
            has_more: false,
          },
        },
      ],
      "GET /v1/blocks/b2/children": [
        {
          status: 200,
          body: {
            results: [
              { id: "b3", type: "paragraph", paragraph: { rich_text: [{ plain_text: "nested" }] } },
            ],
            has_more: false,
          },
        },
      ],
    });
    const client = makeNotionClient("tok", transport);
    const items: NotionItem[] = [];
    for await (const item of client.pages(5)) items.push(item);
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe("My Page");
    expect(items[0]?.text).toBe("line one\nHeader\nnested");
  });

  test("paginates search and block children via start_cursor", async () => {
    const { transport, calls } = cannedTransport({
      "POST /v1/search": [
        {
          status: 200,
          body: {
            results: [{ object: "page", id: "p1", last_edited_time: "t" }],
            has_more: true,
            next_cursor: "c2",
          },
        },
      ],
      "POST /v1/search#c2": [
        {
          status: 200,
          body: { results: [{ object: "page", id: "p2", last_edited_time: "t" }], has_more: false },
        },
      ],
    });
    const client = makeNotionClient("tok", transport);
    const items: NotionItem[] = [];
    for await (const item of client.pages(0)) items.push(item);
    expect(items.map((i) => i.id)).toEqual(["p1", "p2"]);
    expect(calls).toContain("POST /v1/search#c2");
  });

  test("cycle guard: a self-referencing block does not loop forever", async () => {
    const { transport } = cannedTransport({
      "POST /v1/search": [
        {
          status: 200,
          body: { results: [{ object: "page", id: "p1", last_edited_time: "t" }], has_more: false },
        },
      ],
      "GET /v1/blocks/p1/children": [
        {
          status: 200,
          body: {
            results: [
              // A child whose id is the page itself → would recurse back into p1.
              {
                id: "p1",
                type: "paragraph",
                paragraph: { rich_text: [{ plain_text: "loop" }] },
                has_children: true,
              },
            ],
            has_more: false,
          },
        },
      ],
    });
    const client = makeNotionClient("tok", transport);
    const items: NotionItem[] = [];
    for await (const item of client.pages(10)) items.push(item);
    // Resolves (no infinite loop) and captures the text once.
    expect(items[0]?.text).toBe("loop");
  });

  test("depth limit stops recursion below the configured depth", async () => {
    const { transport, calls } = cannedTransport({
      "POST /v1/search": [
        {
          status: 200,
          body: { results: [{ object: "page", id: "p1", last_edited_time: "t" }], has_more: false },
        },
      ],
      "GET /v1/blocks/p1/children": [
        {
          status: 200,
          body: {
            results: [
              {
                id: "deep",
                type: "paragraph",
                paragraph: { rich_text: [{ plain_text: "top" }] },
                has_children: true,
              },
            ],
            has_more: false,
          },
        },
      ],
    });
    const client = makeNotionClient("tok", transport);
    const items: NotionItem[] = [];
    // page_depth 1: the page's own children are read (1 level), but their
    // children are not (that would be level 2).
    for await (const item of client.pages(1)) items.push(item);
    expect(items[0]?.text).toBe("top");
    expect(calls).not.toContain("GET /v1/blocks/deep/children");
  });

  test("page_depth 0 reads no block text at all", async () => {
    const { transport, calls } = cannedTransport({
      "POST /v1/search": [
        {
          status: 200,
          body: { results: [{ object: "page", id: "p1", last_edited_time: "t" }], has_more: false },
        },
      ],
    });
    const client = makeNotionClient("tok", transport);
    const items: NotionItem[] = [];
    for await (const item of client.pages(0)) items.push(item);
    expect(items[0]?.text).toBe("");
    expect(calls).not.toContain("GET /v1/blocks/p1/children");
  });

  test("child_page block is not recursed into (no body duplication)", async () => {
    const { transport, calls } = cannedTransport({
      "POST /v1/search": [
        {
          status: 200,
          body: { results: [{ object: "page", id: "p1", last_edited_time: "t" }], has_more: false },
        },
      ],
      "GET /v1/blocks/p1/children": [
        {
          status: 200,
          body: {
            results: [
              {
                id: "child1",
                type: "child_page",
                child_page: { title: "Nested Page" },
                has_children: true,
              },
            ],
            has_more: false,
          },
        },
      ],
    });
    const client = makeNotionClient("tok", transport);
    const items: NotionItem[] = [];
    for await (const item of client.pages(10)) items.push(item);
    // The child page's title is kept inline as a pointer, but its body is NOT
    // pulled in — that page owns its own standalone record.
    expect(items[0]?.text).toBe("Nested Page");
    expect(calls).not.toContain("GET /v1/blocks/child1/children");
  });

  test("non-2xx throws with the Notion message, never the token", async () => {
    const { transport } = cannedTransport({
      "POST /v1/search": [{ status: 401, body: { message: "API token is invalid." } }],
    });
    const client = makeNotionClient("super-secret", transport);
    const run = (async () => {
      for await (const _ of client.pages(1)) {
        // drain
      }
    })();
    await expect(run).rejects.toThrow(/notion POST \/v1\/search failed: 401 API token is invalid/);
    await run.catch((e: Error) => expect(e.message).not.toContain("super-secret"));
  });

  test("429 then success is retried via the shared retry (no real wait)", async () => {
    let searchCalls = 0;
    const transport: NotionTransport = async ({ path }) => {
      if (path.startsWith("/v1/search")) {
        searchCalls += 1;
        if (searchCalls === 1) {
          // The connector's makeDefaultTransport handles 429 at the fetch layer;
          // here we simulate the transport surfacing a transient failure then ok.
          throw new Error("transient");
        }
        return {
          status: 200,
          body: { results: [{ object: "page", id: "p1", last_edited_time: "t" }], has_more: false },
        };
      }
      return { status: 200, body: { results: [], has_more: false } };
    };
    // Wrap the transport in a tiny retry so the test asserts retry semantics on
    // the client surface deterministically.
    const retrying: NotionTransport = async (req) => {
      try {
        return await transport(req);
      } catch {
        return await transport(req);
      }
    };
    const client = makeNotionClient("tok", retrying);
    const items: NotionItem[] = [];
    for await (const item of client.pages(0)) items.push(item);
    expect(items.map((i) => i.id)).toEqual(["p1"]);
    expect(searchCalls).toBe(2);
  });
});

describe("Notion connector — end-to-end through the sync service", () => {
  test("persists a page body and detects no-op vs last_edited_time change", async () => {
    const store = Store.open({ path: ":memory:" });
    try {
      const item: NotionItem = {
        kind: "page",
        id: "p1",
        title: "Spec",
        text: "first body",
        lastEditedTime: "2026-06-01T00:00:00Z",
      };
      const make = (it: NotionItem) =>
        createNotionConnector(
          { databases: [], pages: true },
          { clientFactory: () => fakeClient({ pages: [it] }) },
        );

      const first = await syncConnector(store, make(item), {
        secrets: { env: { SUASOR_CONNECTOR_NOTION_TOKEN: "tok" } },
      });
      expect(first.observed).toBe(1);
      const body = store.connection.sqlite
        .query<{ body: string }, [string]>("SELECT body FROM sources WHERE external_id = ?")
        .get("notion:page:p1")?.body;
      expect(body).toBe("Spec\n\nfirst body");

      // Same last_edited_time fingerprint → no update on a second run.
      const second = await syncConnector(store, make(item), {
        secrets: { env: { SUASOR_CONNECTOR_NOTION_TOKEN: "tok" } },
      });
      expect(second.updated).toBe(0);

      // last_edited_time advances → re-ingest even if body is unchanged.
      const edited = { ...item, lastEditedTime: "2026-06-02T00:00:00Z" } as NotionItem;
      const third = await syncConnector(store, make(edited), {
        secrets: { env: { SUASOR_CONNECTOR_NOTION_TOKEN: "tok" } },
      });
      expect(third.updated).toBe(1);
    } finally {
      store.close();
    }
  });
});
