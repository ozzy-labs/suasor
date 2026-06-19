import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../../src/db/index.ts";
import { buildMcpServer, EMBEDDING_DISABLED_SIGNAL } from "../../src/mcp/server.ts";
import { type Embedder, EmbeddingError } from "../../src/retrieval/embedding/index.ts";

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
async function connect(
  embedding: "disabled" | "ollama" = "disabled",
  embedder?: Embedder | null,
): Promise<Client> {
  const server = buildMcpServer({
    sqlite: store.connection.sqlite,
    embedding,
    ...(embedder !== undefined ? { embedder } : {}),
  });
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
        "brief",
        "decision.list",
        "inbox.list",
        "recall.search",
        "search",
        "slack.demand.list",
        "source.get",
        "source.list",
        "task.list",
      ].sort(),
    );
  });

  test("slack.demand.list returns @mentions (config self id) and DMs", async () => {
    const slack = (id: string, channel: string, body: string) =>
      store.record({
        type: "SourceObserved",
        externalId: id,
        sourceType: "slack_message",
        body,
        observedAt: "2026-06-14T00:00:00.000Z",
        fingerprint: id,
        meta: { team: "T1", channel },
      });
    slack("m1", "C1", "please review <@U_ME>");
    slack("d1", "D9", "direct ping");
    slack("n1", "C1", "ordinary chatter");

    const server = buildMcpServer({
      sqlite: store.connection.sqlite,
      embedding: "disabled",
      slackSelfUserIds: ["U_ME"],
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const res = await client.callTool({ name: "slack.demand.list", arguments: {} });
    const { demand } = parseResult(res as never) as {
      demand: { externalId: string; kind: string }[];
    };
    expect(demand.map((d) => d.externalId).sort()).toEqual(["d1", "m1"]);
    expect(demand.find((d) => d.externalId === "d1")?.kind).toBe("dm");
  });

  test("brief bundles the period's material by section (ADR-0017)", async () => {
    seedSource("s1", "in-window source"); // observedAt 2026-06-14 (seedSource default)
    store.record(
      { type: "DecisionRecorded", decisionId: "dec1", title: "d", rationale: "" },
      new Date("2026-06-14T00:00:00.000Z"),
    );
    const client = await connect();
    const res = await client.callTool({
      name: "brief",
      arguments: { since: "2026-06-13T00:00:00.000Z", until: "2026-06-15T00:00:00.000Z" },
    });
    const brief = parseResult(res as never) as {
      window: { since: string; until: string };
      sources: { externalId: string }[];
      decisions: { id: string }[];
      inbox: unknown[];
      demand: unknown[];
    };
    expect(brief.window.since).toBe("2026-06-13T00:00:00.000Z");
    expect(brief.sources.map((s) => s.externalId)).toContain("s1");
    expect(brief.decisions.map((d) => d.id)).toEqual(["dec1"]);
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

  test("recall.search degrades (signal) when the sidecar is unreachable", async () => {
    seedSource();
    // Backend enabled, but the injected embedder throws (sidecar down).
    const failing: Embedder = {
      model: "bge-m3",
      embed: () => Promise.reject(new EmbeddingError("ollama down")),
    };
    const client = await connect("ollama", failing);
    const res = await client.callTool({ name: "recall.search", arguments: { query: "rocket" } });
    const parsed = parseResult(res as never) as { hits: unknown[]; signal: string; reason: string };
    expect(parsed.hits).toEqual([]);
    // Signal stays embedding_disabled so hosts keep falling back to `search`.
    expect(parsed.signal).toBe(EMBEDDING_DISABLED_SIGNAL);
    expect(parsed.reason).toBe("backend_unreachable");
  });

  test("recall.search returns vec0 KNN hits when an embedder is enabled", async () => {
    // A dedicated 3-dim store so the fixed test vectors fit the vec0 column.
    const knnStore = Store.open({ path: ":memory:", embeddingDim: 3 });
    try {
      knnStore.record({
        type: "SourceObserved",
        externalId: "gh:1",
        sourceType: "github_issue",
        body: "kubernetes deployment rollout",
        observedAt: "2026-06-14T00:00:00.000Z",
        fingerprint: "gh:1",
        meta: {},
      });
      knnStore.record({
        type: "SourceObserved",
        externalId: "gh:2",
        sourceType: "github_issue",
        body: "lunch menu for friday",
        observedAt: "2026-06-14T00:00:00.000Z",
        fingerprint: "gh:2",
        meta: {},
      });
      // Deterministic fake embedder: known bodies/queries → fixed 3-vectors so
      // KNN ranking is predictable without a live sidecar.
      const vectors: Record<string, number[]> = {
        "kubernetes deployment rollout": [1, 0, 0],
        "lunch menu for friday": [0, 1, 0],
        "deploy to the cluster": [0.9, 0.1, 0], // semantically near gh:1
      };
      const fake: Embedder = {
        model: "fake-3d",
        embed: (texts) => Promise.resolve(texts.map((t) => vectors[t] ?? [0, 0, 1])),
      };
      const { embedSources } = await import("../../src/retrieval/embedding/index.ts");
      await embedSources(knnStore.connection.sqlite, fake, [
        { externalId: "gh:1", body: "kubernetes deployment rollout" },
        { externalId: "gh:2", body: "lunch menu for friday" },
      ]);

      const server = buildMcpServer({
        sqlite: knnStore.connection.sqlite,
        embedding: "ollama",
        embedder: fake,
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test", version: "0.0.0" });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      const res = await client.callTool({
        name: "recall.search",
        arguments: { query: "deploy to the cluster" },
      });
      const parsed = parseResult(res as never) as {
        hits: { externalId: string }[];
        reason: string;
        signal?: string;
      };
      expect(parsed.signal).toBeUndefined();
      expect(parsed.reason).toBe("ok");
      expect(parsed.hits[0]?.externalId).toBe("gh:1"); // nearest neighbour
    } finally {
      knnStore.close();
    }
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

describe("MCP write surface (connector.sync, HITL — ADR-0007 / #10)", () => {
  /** Connect a client to a server built WITH the write tool enabled. */
  async function connectWrite(connectors: Record<string, Record<string, unknown>> = {}) {
    const server = buildMcpServer({
      sqlite: store.connection.sqlite,
      embedding: "disabled",
      write: { store, config: { connectors } },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  test("connector.sync is registered as a write tool (readOnlyHint: false)", async () => {
    const client = await connectWrite();
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "connector.sync");
    expect(tool).toBeDefined();
    expect(tool?.annotations?.readOnlyHint).toBe(false);
  });

  test("a writable server exposes the full read + write tool surface", async () => {
    const client = await connectWrite();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        // read
        "brief",
        "decision.list",
        "inbox.list",
        "recall.search",
        "search",
        "slack.demand.list",
        "source.get",
        "source.list",
        "task.list",
        // write (HITL)
        "connector.sync",
        "propose.generate",
        "propose.apply",
        "task.create",
      ].sort(),
    );
  });

  test("every write tool carries readOnlyHint: false (HITL-gated)", async () => {
    const client = await connectWrite();
    const { tools } = await client.listTools();
    const writeTools = ["connector.sync", "propose.generate", "propose.apply", "task.create"];
    for (const name of writeTools) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.annotations?.readOnlyHint).toBe(false);
    }
  });

  test("connector.sync is absent when no writable store is supplied", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain("connector.sync");
  });

  test("connector.sync runs the shared service and returns the outcome", async () => {
    // repos:[] → no records (no network), but the write path runs end-to-end.
    const client = await connectWrite({ github: { repos: [] } });
    const res = await client.callTool({
      name: "connector.sync",
      arguments: { connector: "github" },
    });
    const parsed = parseResult(res as never) as { connector: string; observed: number };
    expect(parsed.connector).toBe("github");
    expect(parsed.observed).toBe(0);
  });

  test("connector.sync surfaces an unknown connector as a tool error", async () => {
    const client = await connectWrite();
    const res = (await client.callTool({
      name: "connector.sync",
      arguments: { connector: "nope" },
    })) as { isError?: boolean; content: { type: string; text?: string }[] };
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("unknown connector");
  });
});
