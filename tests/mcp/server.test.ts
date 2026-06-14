import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../../src/db/index.ts";
import { buildMcpServer, EMBEDDING_DISABLED_SIGNAL } from "../../src/mcp/server.ts";

let store: Store;

beforeEach(() => {
  store = Store.open({ path: ":memory:" });
});

afterEach(() => {
  store.close();
});

/** Seed a source so retrieval/list tools have something to return. */
function seedSource(externalId = "gh:1", body = "deploy the rocket to mars") {
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

/** Connect an in-process MCP client to a freshly built server. */
async function connect(embeddingBackend = "disabled"): Promise<Client> {
  const server = buildMcpServer({ sqlite: store.connection.sqlite, embeddingBackend });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** Parse the single JSON text content block returned by a tool. */
function parseResult(res: { content: { type: string; text?: string }[] }): unknown {
  const block = res.content[0];
  expect(block?.type).toBe("text");
  return JSON.parse(block?.text ?? "");
}

describe("MCP read surface", () => {
  test("exposes exactly the #8 read tools", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "decision.list",
        "inbox.list",
        "recall.search",
        "search",
        "source.get",
        "source.list",
        "task.list",
      ].sort(),
    );
  });

  test("every tool is annotated read-only (auto-approve hint, no side effects)", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
  });

  test("search returns FTS-ranked hits", async () => {
    seedSource();
    const client = await connect();
    const res = await client.callTool({ name: "search", arguments: { query: "rocket" } });
    const parsed = parseResult(res as never) as {
      strategy: string;
      hits: { externalId: string }[];
    };
    expect(parsed.strategy).toBe("fts");
    expect(parsed.hits[0]?.externalId).toBe("gh:1");
  });

  test("recall.search returns empty + embedding_disabled signal when off", async () => {
    seedSource();
    const client = await connect("disabled");
    const res = await client.callTool({ name: "recall.search", arguments: { query: "rocket" } });
    const parsed = parseResult(res as never) as { hits: unknown[]; signal: string; reason: string };
    expect(parsed.hits).toEqual([]);
    expect(parsed.signal).toBe(EMBEDDING_DISABLED_SIGNAL);
    expect(parsed.reason).toBe("backend_disabled");
  });

  test("recall.search still degrades (signal) when a backend is configured but unimplemented", async () => {
    const client = await connect("ollama");
    const res = await client.callTool({ name: "recall.search", arguments: { query: "rocket" } });
    const parsed = parseResult(res as never) as { hits: unknown[]; signal: string; reason: string };
    expect(parsed.hits).toEqual([]);
    // Signal stays embedding_disabled so hosts keep falling back to `search`.
    expect(parsed.signal).toBe(EMBEDDING_DISABLED_SIGNAL);
    expect(parsed.reason).toBe("recall_unimplemented");
  });

  test("source.list returns ingested sources; source.get fetches a body", async () => {
    seedSource("gh:1", "first source");
    seedSource("gh:2", "second source");
    const client = await connect();

    const listRes = await client.callTool({ name: "source.list", arguments: {} });
    const list = parseResult(listRes as never) as { sources: { externalId: string }[] };
    expect(list.sources.map((s) => s.externalId).sort()).toEqual(["gh:1", "gh:2"]);

    const getRes = await client.callTool({
      name: "source.get",
      arguments: { externalId: "gh:1" },
    });
    const got = parseResult(getRes as never) as { source: { body: string } | null };
    expect(got.source?.body).toBe("first source");
  });

  test("source.get returns null source for an unknown id", async () => {
    const client = await connect();
    const res = await client.callTool({ name: "source.get", arguments: { externalId: "nope" } });
    const parsed = parseResult(res as never) as { source: unknown };
    expect(parsed.source).toBeNull();
  });

  test("task.list / decision.list / inbox.list return projection rows", async () => {
    seedSource("gh:1");
    store.record({ type: "TaskProposed", taskId: "t1", title: "do it", sourceExternalIds: [] });
    store.record({ type: "DecisionRecorded", decisionId: "d1", title: "chose X", rationale: "" });
    store.record({
      type: "InboxItemTriaged",
      inboxId: "i1",
      sourceExternalId: "gh:1",
      state: "open",
    });
    const client = await connect();

    const tasks = parseResult(
      (await client.callTool({ name: "task.list", arguments: {} })) as never,
    ) as {
      tasks: { id: string }[];
    };
    expect(tasks.tasks.map((t) => t.id)).toEqual(["t1"]);

    const decisions = parseResult(
      (await client.callTool({ name: "decision.list", arguments: {} })) as never,
    ) as { decisions: { id: string }[] };
    expect(decisions.decisions.map((d) => d.id)).toEqual(["d1"]);

    const inbox = parseResult(
      (await client.callTool({ name: "inbox.list", arguments: {} })) as never,
    ) as { items: { id: string }[] };
    expect(inbox.items.map((i) => i.id)).toEqual(["i1"]);
  });

  test("task.list filters by state", async () => {
    store.record({ type: "TaskProposed", taskId: "t1", title: "a", sourceExternalIds: [] });
    store.record({ type: "TaskApplied", taskId: "t1", state: "completed" });
    store.record({ type: "TaskProposed", taskId: "t2", title: "b", sourceExternalIds: [] });
    const client = await connect();
    const res = await client.callTool({ name: "task.list", arguments: { state: "completed" } });
    const parsed = parseResult(res as never) as { tasks: { id: string }[] };
    expect(parsed.tasks.map((t) => t.id)).toEqual(["t1"]);
  });

  test("read tools have no side effects (event/projection counts unchanged)", async () => {
    seedSource("gh:1");
    const sqlite = store.connection.sqlite;
    const countSources = () =>
      sqlite.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sources").get()?.n ?? -1;
    const countEvents = () =>
      sqlite.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events").get()?.n ?? -1;
    const beforeSources = countSources();
    const beforeEvents = countEvents();

    const client = await connect();
    await client.callTool({ name: "search", arguments: { query: "rocket" } });
    await client.callTool({ name: "source.list", arguments: {} });
    await client.callTool({ name: "source.get", arguments: { externalId: "gh:1" } });
    await client.callTool({ name: "task.list", arguments: {} });

    expect(countSources()).toBe(beforeSources);
    expect(countEvents()).toBe(beforeEvents);
  });

  test("rejects an invalid argument via SDK Zod validation", async () => {
    const client = await connect();
    // `search.query` must be a non-empty string; the SDK validates the input
    // schema before the handler runs and returns a tool error result.
    const res = (await client.callTool({ name: "search", arguments: { query: "" } })) as {
      isError?: boolean;
      content: { type: string; text?: string }[];
    };
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("validation");
  });
});
