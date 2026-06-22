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

/** Parse a structured tool error body `{ code, message, hint }` (ADR-0031). */
function parseError(res: { isError?: boolean; content: { type: string; text?: string }[] }): {
  code: string;
  message: string;
  hint?: string;
} {
  expect(res.isError).toBe(true);
  return parseResult(res) as { code: string; message: string; hint?: string };
}

describe("MCP read surface", () => {
  test("exposes exactly the #8 read tools", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "activity.timeline",
        "brief",
        "commitment.list",
        "decision.list",
        "graph.expand",
        "graph.related",
        "inbox.list",
        "person.list",
        "propose.list",
        "recall.search",
        "search",
        "search.hybrid",
        "slack.demand.list",
        "source.get",
        "source.get.full",
        "source.history",
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
      warnings: { key: string }[];
    };
    expect(brief.window.since).toBe("2026-06-13T00:00:00.000Z");
    expect(brief.sources.map((s) => s.externalId)).toContain("s1");
    expect(brief.decisions.map((d) => d.id)).toEqual(["dec1"]);
  });

  test("brief flags unconfigured categories via warnings (Issue #189)", async () => {
    // Default connect(): embedding disabled + Slack unconfigured → both signals.
    const client = await connect();
    const res = await client.callTool({ name: "brief", arguments: {} });
    const { warnings } = parseResult(res as never) as { warnings: { key: string }[] };
    expect(warnings.map((w) => w.key)).toEqual(["slack_not_configured", "embedding_disabled"]);
  });

  test("brief omits warnings when Slack + embedding are configured (Issue #189)", async () => {
    const server = buildMcpServer({
      sqlite: store.connection.sqlite,
      embedding: "ollama",
      slackConfigured: true,
      slackSelfUserIds: ["U1"],
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const res = await client.callTool({ name: "brief", arguments: {} });
    const { warnings } = parseResult(res as never) as { warnings: unknown[] };
    expect(warnings).toEqual([]);
  });

  test("graph.related / graph.expand traverse the links projection (ADR-0018)", async () => {
    // task t1 --derived_from--> source s1 (materialised by the reducer).
    store.record({ type: "TaskProposed", taskId: "t1", title: "t", sourceExternalIds: ["s1"] });
    const client = await connect();

    const related = parseResult(
      (await client.callTool({
        name: "graph.related",
        arguments: { kind: "source", id: "s1" },
      })) as never,
    ) as { neighbors: { kind: string; id: string; relation: string; direction: string }[] };
    expect(related.neighbors).toEqual([
      { kind: "task", id: "t1", relation: "derived_from", direction: "in" },
    ]);

    const expand = parseResult(
      (await client.callTool({
        name: "graph.expand",
        arguments: { kind: "task", id: "t1", depth: 1 },
      })) as never,
    ) as { nodes: { kind: string; id: string }[] };
    expect(expand.nodes.map((n) => `${n.kind}:${n.id}`).sort()).toEqual(["source:s1", "task:t1"]);
  });

  test("graph.expand direction traces incoming provenance (ADR-0020)", async () => {
    // task t1 --derived_from--> source s1; from s1 the backward trace finds t1.
    store.record({ type: "TaskProposed", taskId: "t1", title: "t", sourceExternalIds: ["s1"] });
    const client = await connect();

    const inExpand = parseResult(
      (await client.callTool({
        name: "graph.expand",
        arguments: { kind: "source", id: "s1", depth: 2, direction: "in" },
      })) as never,
    ) as { nodes: { kind: string; id: string }[] };
    expect(inExpand.nodes.map((n) => `${n.kind}:${n.id}`).sort()).toEqual(["source:s1", "task:t1"]);

    // out from s1 finds nothing downstream (s1 has no outgoing edge).
    const outExpand = parseResult(
      (await client.callTool({
        name: "graph.expand",
        arguments: { kind: "source", id: "s1", depth: 2, direction: "out" },
      })) as never,
    ) as { nodes: { kind: string; id: string }[] };
    expect(outExpand.nodes.map((n) => `${n.kind}:${n.id}`)).toEqual(["source:s1"]);
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
      totalHits: number;
      truncated: boolean;
      analyzedQuery: string[];
    };
    expect(parsed.strategy).toBe("fts");
    expect(parsed.hits[0]?.externalId).toBe("gh:1");
    // Transparency fields are returned through the MCP surface (Issue #186).
    expect(parsed.totalHits).toBe(1);
    expect(parsed.truncated).toBe(false);
    expect(parsed.analyzedQuery).toEqual(["rocket"]);
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

  test("search honours the sourceType + observed window filter args", async () => {
    store.record({
      type: "SourceObserved",
      externalId: "gh:1",
      sourceType: "github_issue",
      body: "deploy the rocket",
      observedAt: "2026-06-14T00:00:00.000Z",
      fingerprint: "gh:1",
      meta: {},
    });
    store.record({
      type: "SourceObserved",
      externalId: "sl:1",
      sourceType: "slack_message",
      body: "deploy the rocket",
      observedAt: "2026-06-14T00:00:00.000Z",
      fingerprint: "sl:1",
      meta: {},
    });
    const client = await connect();
    const res = await client.callTool({
      name: "search",
      arguments: { query: "rocket", sourceType: "slack_message" },
    });
    const parsed = parseResult(res as never) as { hits: { externalId: string }[] };
    expect(parsed.hits.map((h) => h.externalId)).toEqual(["sl:1"]);
  });

  test("search.hybrid degrades to FTS-only with embedding_disabled when off", async () => {
    seedSource();
    const client = await connect("disabled");
    const res = await client.callTool({ name: "search.hybrid", arguments: { query: "rocket" } });
    const parsed = parseResult(res as never) as {
      hits: { externalId: string; rrfScore: number }[];
      signal?: string;
    };
    expect(parsed.signal).toBe(EMBEDDING_DISABLED_SIGNAL);
    expect(parsed.hits[0]?.externalId).toBe("gh:1");
    expect(parsed.hits[0]?.rrfScore).toBeGreaterThan(0);
  });

  test("search.hybrid fuses FTS + vec hits (RRF) when an embedder is enabled", async () => {
    const knnStore = Store.open({ path: ":memory:", embeddingDim: 3 });
    try {
      const seed = (id: string, body: string) =>
        knnStore.record({
          type: "SourceObserved",
          externalId: id,
          sourceType: "github_issue",
          body,
          observedAt: "2026-06-14T00:00:00.000Z",
          fingerprint: id,
          meta: {},
        });
      // gh:1 is the lexical match for "rocket"; gh:2 is only a semantic neighbour.
      seed("gh:1", "rocket launch plan");
      seed("gh:2", "spacecraft trajectory notes");
      const vectors: Record<string, number[]> = {
        "rocket launch plan": [0, 1, 0],
        "spacecraft trajectory notes": [1, 0, 0],
        rocket: [1, 0, 0], // query vector closest to gh:2
      };
      const fake: Embedder = {
        model: "fake-3d",
        embed: (texts) => Promise.resolve(texts.map((t) => vectors[t] ?? [0, 0, 1])),
      };
      const { embedSources } = await import("../../src/retrieval/embedding/index.ts");
      await embedSources(knnStore.connection.sqlite, fake, [
        { externalId: "gh:1", body: "rocket launch plan" },
        { externalId: "gh:2", body: "spacecraft trajectory notes" },
      ]);

      const server = buildMcpServer({
        sqlite: knnStore.connection.sqlite,
        embedding: "ollama",
        embedder: fake,
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test", version: "0.0.0" });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      const res = await client.callTool({ name: "search.hybrid", arguments: { query: "rocket" } });
      const parsed = parseResult(res as never) as {
        hits: { externalId: string; rrfScore: number }[];
        signal?: string;
      };
      expect(parsed.signal).toBeUndefined();
      // Both paths contribute: gh:1 (FTS) and gh:2 (vec) both appear, deduped.
      expect(parsed.hits.map((h) => h.externalId).sort()).toEqual(["gh:1", "gh:2"]);
      expect(parsed.hits.every((h) => h.rrfScore > 0)).toBe(true);
    } finally {
      knnStore.close();
    }
  });

  // Cold-start / loaded-runner hardening: this case once tripped the default
  // 5000ms timeout on a cold start despite normally finishing in ~1ms. The work
  // (seed two events + build an in-process MCP server + two tool round-trips) is
  // not slow; the margin guards against runner startup jitter, not a real perf
  // regression. See issue #233.
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
  }, 15_000);

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

  test("task.list filters by dueWithinDays (due soon)", async () => {
    // Soon: 1 day out. Later: far beyond any reasonable window.
    const soon = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const later = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    store.record({
      type: "TaskProposed",
      taskId: "soon",
      title: "due soon",
      dueDate: soon,
      sourceExternalIds: [],
    });
    store.record({ type: "TaskApplied", taskId: "soon", state: "open" });
    store.record({
      type: "TaskProposed",
      taskId: "later",
      title: "due later",
      dueDate: later,
      sourceExternalIds: [],
    });
    store.record({ type: "TaskApplied", taskId: "later", state: "open" });
    const client = await connect();
    const res = await client.callTool({ name: "task.list", arguments: { dueWithinDays: 7 } });
    const parsed = parseResult(res as never) as { tasks: { id: string }[] };
    expect(parsed.tasks.map((t) => t.id)).toEqual(["soon"]);
  });

  test("inbox.list filters by sourceType", async () => {
    seedSource("gh:1");
    store.record({
      type: "SourceObserved",
      externalId: "sl:1",
      sourceType: "slack_message",
      body: "ping",
      observedAt: "2026-06-11T00:00:00.000Z",
      fingerprint: "sl:1",
      meta: {},
    });
    store.record({
      type: "InboxItemTriaged",
      inboxId: "ig",
      sourceExternalId: "gh:1",
      state: "open",
    });
    store.record({
      type: "InboxItemTriaged",
      inboxId: "is",
      sourceExternalId: "sl:1",
      state: "open",
    });
    const client = await connect();
    const res = await client.callTool({
      name: "inbox.list",
      arguments: { sourceType: "slack_message" },
    });
    const parsed = parseResult(res as never) as { items: { id: string }[] };
    expect(parsed.items.map((i) => i.id)).toEqual(["is"]);
  });

  test("commitment.list filters by person", async () => {
    store.record({
      type: "CommitmentOpened",
      commitmentId: "c1",
      title: "owe Alice the deck",
      direction: "owed_by_me",
      person: "Alice",
      sourceExternalIds: [],
    });
    store.record({
      type: "CommitmentOpened",
      commitmentId: "c2",
      title: "Bob owes a review",
      direction: "owed_to_me",
      person: "Bob",
      sourceExternalIds: [],
    });
    const client = await connect();
    const res = await client.callTool({
      name: "commitment.list",
      arguments: { person: "Alice" },
    });
    const parsed = parseResult(res as never) as { commitments: { id: string }[] };
    expect(parsed.commitments.map((c) => c.id)).toEqual(["c1"]);
  });

  // Truncation transparency (ADR-0007 "no silent wrong answer", Issue #290): a
  // list tool returning exactly `limit` rows must say whether more matched.
  test("source.list reports truncated:true at the limit, false below it", async () => {
    seedSource("gh:1", "a");
    seedSource("gh:2", "b");
    seedSource("gh:3", "c");
    const client = await connect();

    // 3 rows, limit 2 → a full page that hides a 3rd row ⇒ truncated.
    const cut = parseResult(
      (await client.callTool({ name: "source.list", arguments: { limit: 2 } })) as never,
    ) as { sources: { externalId: string }[]; truncated: boolean };
    expect(cut.sources).toHaveLength(2);
    expect(cut.truncated).toBe(true);

    // 3 rows, limit 5 → the whole set fits ⇒ complete.
    const whole = parseResult(
      (await client.callTool({ name: "source.list", arguments: { limit: 5 } })) as never,
    ) as { sources: { externalId: string }[]; truncated: boolean };
    expect(whole.sources).toHaveLength(3);
    expect(whole.truncated).toBe(false);
  });

  test("task.list / decision.list / inbox.list carry the truncated flag", async () => {
    seedSource("gh:1");
    for (const id of ["t1", "t2"]) {
      store.record({ type: "TaskProposed", taskId: id, title: id, sourceExternalIds: [] });
    }
    for (const id of ["d1", "d2"]) {
      store.record({ type: "DecisionRecorded", decisionId: id, title: id, rationale: "" });
    }
    store.record({
      type: "InboxItemTriaged",
      inboxId: "i1",
      sourceExternalId: "gh:1",
      state: "open",
    });
    const client = await connect();

    const tasks = parseResult(
      (await client.callTool({ name: "task.list", arguments: { limit: 1 } })) as never,
    ) as { tasks: unknown[]; truncated: boolean };
    expect(tasks.tasks).toHaveLength(1);
    expect(tasks.truncated).toBe(true);

    const decisions = parseResult(
      (await client.callTool({ name: "decision.list", arguments: { limit: 2 } })) as never,
    ) as { decisions: unknown[]; truncated: boolean };
    expect(decisions.decisions).toHaveLength(2);
    expect(decisions.truncated).toBe(false);

    // Only one inbox item exists, so a generous limit is never truncated.
    const inbox = parseResult(
      (await client.callTool({ name: "inbox.list", arguments: {} })) as never,
    ) as { items: unknown[]; truncated: boolean };
    expect(inbox.items).toHaveLength(1);
    expect(inbox.truncated).toBe(false);
  });

  test("task.list truncation holds under the overdue post-filter", async () => {
    // overdue is a read-time post-filter (not a SQL column): truncation must
    // count the filtered set, not the raw SELECT (queries.ts limit deferral).
    const past = "2000-01-01T00:00:00.000Z";
    for (const id of ["o1", "o2", "o3"]) {
      store.record({
        type: "TaskProposed",
        taskId: id,
        title: id,
        dueDate: past,
        sourceExternalIds: [],
      });
      store.record({ type: "TaskApplied", taskId: id, state: "open" });
    }
    const client = await connect();
    const res = parseResult(
      (await client.callTool({
        name: "task.list",
        arguments: { overdue: true, limit: 2 },
      })) as never,
    ) as { tasks: { overdue: boolean }[]; truncated: boolean };
    expect(res.tasks).toHaveLength(2);
    expect(res.tasks.every((t) => t.overdue)).toBe(true);
    expect(res.truncated).toBe(true);
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

  test("source.get.full bundles body + outgoing links + extraction_meta (#279)", async () => {
    seedSource("s1", "rocket plans");
    store.record({
      type: "LinkAdded",
      linkId: "ln1",
      fromKind: "source",
      fromId: "s1",
      toKind: "decision",
      toId: "d1",
    });
    const client = await connect();
    const res = await client.callTool({
      name: "source.get.full",
      arguments: { externalId: "s1" },
    });
    const full = parseResult(res as never) as {
      source: { externalId: string; body: string } | null;
      links: { kind: string; id: string; relation: string; direction: string; linkId?: string }[];
      extractionMeta: unknown;
    };
    expect(full.source?.externalId).toBe("s1");
    expect(full.source?.body).toBe("rocket plans");
    expect(full.links).toEqual([
      { kind: "decision", id: "d1", relation: "manual_link", direction: "out", linkId: "ln1" },
    ]);
    expect(full.extractionMeta).toBeNull();
  });

  test("source.get.full rejects an empty externalId (input validation)", async () => {
    const client = await connect();
    const res = (await client.callTool({
      name: "source.get.full",
      arguments: { externalId: "" },
    })) as { isError?: boolean; content: { type: string; text?: string }[] };
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("validation");
  });

  test("activity.timeline merges connected entities newest-first (#279)", async () => {
    seedSource("s1", "source body"); // observedAt 2026-06-14
    store.record({
      type: "TaskProposed",
      taskId: "t1",
      title: "derived task",
      sourceExternalIds: ["s1"],
    });
    const client = await connect();
    const res = await client.callTool({
      name: "activity.timeline",
      arguments: { kind: "source", id: "s1" },
    });
    const timeline = parseResult(res as never) as {
      origin: { kind: string; id: string };
      items: { kind: string; id: string; at: string }[];
    };
    expect(timeline.origin).toEqual({ kind: "source", id: "s1" });
    expect(timeline.items.map((i) => i.kind).sort()).toEqual(["source", "task"]);
  });

  test("activity.timeline rejects an empty id (input validation)", async () => {
    const client = await connect();
    const res = (await client.callTool({
      name: "activity.timeline",
      arguments: { kind: "person", id: "" },
    })) as { isError?: boolean; content: { type: string; text?: string }[] };
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
        "activity.timeline",
        "brief",
        "commitment.list",
        "decision.list",
        "graph.expand",
        "graph.related",
        "inbox.list",
        "person.list",
        "propose.list",
        "recall.search",
        "search",
        "search.hybrid",
        "slack.demand.list",
        "source.get",
        "source.get.full",
        "source.history",
        "source.list",
        "task.list",
        // write (HITL)
        "connector.sync",
        "propose.generate",
        "propose.apply",
        "propose.reject",
        "propose.batch",
        "proposal.feedback",
        "task.create",
        "task.update",
        "task.publish",
        "task.act",
        "decision.record",
        "inbox.add",
        "inbox.triage",
        "link.add",
        "link.remove",
        "commitment.resolve",
        "commitment.dismiss",
        "commitment.reopen",
        "person.merge",
        "person.split",
        "draft.export",
        "source.forget",
      ].sort(),
    );
  });

  test("every write tool carries readOnlyHint: false (HITL-gated)", async () => {
    const client = await connectWrite();
    const { tools } = await client.listTools();
    const writeTools = [
      "connector.sync",
      "propose.generate",
      "propose.apply",
      "propose.reject",
      "propose.batch",
      "proposal.feedback",
      "task.create",
      "task.update",
      "task.publish",
      "task.act",
      "decision.record",
      "inbox.add",
      "inbox.triage",
      "link.add",
      "link.remove",
      "commitment.resolve",
      "commitment.dismiss",
      "commitment.reopen",
      "person.merge",
      "person.split",
      "draft.export",
      "source.forget",
    ];
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

  test("decision.record appends a decision visible via decision.list", async () => {
    const client = await connectWrite();
    const rec = parseResult(
      (await client.callTool({
        name: "decision.record",
        arguments: { title: "use bun", rationale: "fast" },
      })) as never,
    ) as { decisionId: string; status: string };
    expect(rec.status).toBe("created");
    const list = parseResult(
      (await client.callTool({ name: "decision.list", arguments: {} })) as never,
    ) as { decisions: { id: string; title: string }[] };
    expect(list.decisions.map((d) => d.title)).toContain("use bun");
    // Idempotent: a second identical record is a no-op (`existing`).
    const again = parseResult(
      (await client.callTool({
        name: "decision.record",
        arguments: { title: "use bun", rationale: "fast" },
      })) as never,
    ) as { status: string };
    expect(again.status).toBe("existing");
  });

  test("inbox.add captures an open item visible via inbox.list", async () => {
    const client = await connectWrite();
    const add = parseResult(
      (await client.callTool({
        name: "inbox.add",
        arguments: { sourceExternalId: "gh:7" },
      })) as never,
    ) as { inboxId: string; status: string };
    expect(add.status).toBe("created");
    const list = parseResult(
      (await client.callTool({ name: "inbox.list", arguments: {} })) as never,
    ) as { items: { id: string; sourceExternalId: string; state: string }[] };
    const item = list.items.find((i) => i.id === add.inboxId);
    expect(item?.state).toBe("open");
    expect(item?.sourceExternalId).toBe("gh:7");
  });

  test("inbox.triage (task) creates a task and marks the item done", async () => {
    const client = await connectWrite();
    const add = parseResult(
      (await client.callTool({
        name: "inbox.add",
        arguments: { sourceExternalId: "gh:8" },
      })) as never,
    ) as { inboxId: string };
    const tri = parseResult(
      (await client.callTool({
        name: "inbox.triage",
        arguments: { inboxId: add.inboxId, action: "task", title: "do it" },
      })) as never,
    ) as { state: string; createdEntityId: string };
    expect(tri.state).toBe("done");
    const tasks = parseResult(
      (await client.callTool({ name: "task.list", arguments: {} })) as never,
    ) as { tasks: { id: string; title: string }[] };
    expect(tasks.tasks.find((t) => t.id === tri.createdEntityId)?.title).toBe("do it");
  });

  test("inbox.triage rejects an invalid transition as a tool error", async () => {
    const client = await connectWrite();
    const res = (await client.callTool({
      name: "inbox.triage",
      arguments: { inboxId: "inbox_missing", action: "discard" },
    })) as { isError?: boolean; content: { type: string; text?: string }[] };
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("not found");
  });

  test("link.add creates a manual_link visible via graph.related, link.remove deletes it", async () => {
    const client = await connectWrite();
    // task t1 ──manual_link──▶ decision d1
    const add = parseResult(
      (await client.callTool({
        name: "link.add",
        arguments: { fromKind: "task", fromId: "t1", toKind: "decision", toId: "d1" },
      })) as never,
    ) as { linkId: string; status: string };
    expect(add.status).toBe("created");

    // graph.related surfaces the manual link + its linkId (so it can be removed).
    const related = parseResult(
      (await client.callTool({
        name: "graph.related",
        arguments: { kind: "task", id: "t1" },
      })) as never,
    ) as {
      neighbors: {
        kind: string;
        id: string;
        relation: string;
        direction: string;
        linkId?: string;
      }[];
    };
    expect(related.neighbors).toEqual([
      { kind: "decision", id: "d1", relation: "manual_link", direction: "out", linkId: add.linkId },
    ]);

    // link.remove deletes it; the edge disappears from graph.related.
    const rem = parseResult(
      (await client.callTool({
        name: "link.remove",
        arguments: { linkId: add.linkId },
      })) as never,
    ) as { status: string };
    expect(rem.status).toBe("removed");
    const after = parseResult(
      (await client.callTool({
        name: "graph.related",
        arguments: { kind: "task", id: "t1" },
      })) as never,
    ) as { neighbors: unknown[] };
    expect(after.neighbors).toEqual([]);
  });

  test("link.add rejects a self-loop as a tool error", async () => {
    const client = await connectWrite();
    const res = (await client.callTool({
      name: "link.add",
      arguments: { fromKind: "task", fromId: "t1", toKind: "task", toId: "t1" },
    })) as { isError?: boolean; content: { type: string; text?: string }[] };
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("itself");
  });

  test("link.remove rejects a non-existent link as a tool error", async () => {
    const client = await connectWrite();
    const res = (await client.callTool({
      name: "link.remove",
      arguments: { linkId: "link_missing" },
    })) as { isError?: boolean; content: { type: string; text?: string }[] };
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("no manual link");
  });

  test("commitment ledger: generate→apply→list→resolve over MCP (ADR-0021)", async () => {
    const client = await connectWrite();
    // Extract a commitment via the propose pipeline (commitment_scan mode).
    const gen = parseResult(
      (await client.callTool({
        name: "propose.generate",
        arguments: {
          mode: "commitment_scan",
          candidates: [
            { kind: "commitment", title: "send report by Friday", direction: "owed_by_me" },
          ],
        },
      })) as never,
    ) as { candidates: { candidateId: string }[] };
    await client.callTool({
      name: "propose.apply",
      arguments: { candidates: gen.candidates },
    });

    // It shows up as open in commitment.list.
    const open = parseResult(
      (await client.callTool({
        name: "commitment.list",
        arguments: { state: "open" },
      })) as never,
    ) as { commitments: { id: string; direction: string; state: string }[] };
    expect(open.commitments).toHaveLength(1);
    const id = open.commitments[0]?.id as string;
    expect(open.commitments[0]?.direction).toBe("owed_by_me");

    // Resolve it (write tool) → no longer open.
    const resolved = parseResult(
      (await client.callTool({
        name: "commitment.resolve",
        arguments: { commitmentId: id },
      })) as never,
    ) as { status: string };
    expect(resolved.status).toBe("resolved");
    const stillOpen = parseResult(
      (await client.callTool({ name: "commitment.list", arguments: { state: "open" } })) as never,
    ) as { commitments: unknown[] };
    expect(stillOpen.commitments).toHaveLength(0);
  });

  test("proposal.feedback records a reason and keeps the candidate pending (#279)", async () => {
    const client = await connectWrite();
    const gen = parseResult(
      (await client.callTool({
        name: "propose.generate",
        arguments: {
          mode: "source_extract",
          candidates: [{ kind: "task", title: "needs work" }],
        },
      })) as never,
    ) as { candidates: { candidateId: string }[] };
    const candidateId = gen.candidates[0]?.candidateId as string;

    const fb = parseResult(
      (await client.callTool({
        name: "proposal.feedback",
        arguments: { candidateId, reason: "make it concrete" },
      })) as never,
    ) as { status: string; candidateId: string };
    expect(fb.status).toBe("recorded");

    // Still pending, with the recorded reason surfaced via propose.list.
    const pending = parseResult(
      (await client.callTool({
        name: "propose.list",
        arguments: { state: "pending" },
      })) as never,
    ) as { proposals: { candidateId: string; state: string; reason: string }[] };
    expect(pending.proposals).toHaveLength(1);
    expect(pending.proposals[0]?.candidateId).toBe(candidateId);
    expect(pending.proposals[0]?.reason).toBe("make it concrete");
  });

  test("proposal.feedback reports missing for an unknown candidate (#279)", async () => {
    const client = await connectWrite();
    const fb = parseResult(
      (await client.callTool({
        name: "proposal.feedback",
        arguments: { candidateId: "cand_nope", reason: "x" },
      })) as never,
    ) as { status: string };
    expect(fb.status).toBe("missing");
  });

  test("proposal.feedback rejects an empty reason (input validation)", async () => {
    const client = await connectWrite();
    const res = (await client.callTool({
      name: "proposal.feedback",
      arguments: { candidateId: "cand_x", reason: "" },
    })) as { isError?: boolean; content: { type: string; text?: string }[] };
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("validation");
  });
});

describe("MCP structured errors (code/hint — ADR-0031 / #196)", () => {
  /** Connect a writable server (no [export] slice → draft.export errors). */
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

  test("connector.sync → UNKNOWN_CONNECTOR with a hint", async () => {
    const client = await connectWrite();
    const body = parseError(
      (await client.callTool({
        name: "connector.sync",
        arguments: { connector: "nope" },
      })) as never,
    );
    expect(body.code).toBe("UNKNOWN_CONNECTOR");
    expect(body.message).toContain("unknown connector");
    expect(body.hint).toBeTruthy();
  });

  test("inbox.triage on a missing item → MISSING_ENTITY with a hint", async () => {
    const client = await connectWrite();
    const body = parseError(
      (await client.callTool({
        name: "inbox.triage",
        arguments: { inboxId: "inbox_missing", action: "discard" },
      })) as never,
    );
    expect(body.code).toBe("MISSING_ENTITY");
    expect(body.hint).toBeTruthy();
  });

  test("inbox.triage of a non-open item → INVALID_STATE", async () => {
    const client = await connectWrite();
    seedSource("gh:triage");
    // Capture, then triage to done, then re-triage the now-done item.
    const add = parseResult(
      (await client.callTool({
        name: "inbox.add",
        arguments: { sourceExternalId: "gh:triage" },
      })) as never,
    ) as { inboxId: string };
    await client.callTool({
      name: "inbox.triage",
      arguments: { inboxId: add.inboxId, action: "discard" },
    });
    const body = parseError(
      (await client.callTool({
        name: "inbox.triage",
        arguments: { inboxId: add.inboxId, action: "discard" },
      })) as never,
    );
    expect(body.code).toBe("INVALID_STATE");
  });

  test("link.add self-loop → INVALID_INPUT; link.remove unknown → MISSING_ENTITY", async () => {
    const client = await connectWrite();
    const selfLoop = parseError(
      (await client.callTool({
        name: "link.add",
        arguments: { fromKind: "task", fromId: "t1", toKind: "task", toId: "t1" },
      })) as never,
    );
    expect(selfLoop.code).toBe("INVALID_INPUT");
    expect(selfLoop.message).toContain("itself");

    const missing = parseError(
      (await client.callTool({
        name: "link.remove",
        arguments: { linkId: "link_missing" },
      })) as never,
    );
    expect(missing.code).toBe("MISSING_ENTITY");
  });

  test("person.merge self-merge → INVALID_INPUT", async () => {
    const client = await connectWrite();
    const body = parseError(
      (await client.callTool({
        name: "person.merge",
        arguments: { targetPersonId: "p1", sourcePersonId: "p1" },
      })) as never,
    );
    expect(body.code).toBe("INVALID_INPUT");
  });

  test("draft.export without [export].dir → EXPORT_DIR_NOT_CONFIGURED with a hint", async () => {
    const client = await connectWrite(); // no [export] slice
    const body = parseError(
      (await client.callTool({
        name: "draft.export",
        arguments: { content: "hi", filename: "note.md", format: "md" },
      })) as never,
    );
    expect(body.code).toBe("EXPORT_DIR_NOT_CONFIGURED");
    expect(body.hint).toContain("[export].dir");
  });
});
