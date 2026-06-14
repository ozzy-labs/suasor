import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../../src/db/index.ts";
import { buildMcpServer } from "../../src/mcp/server.ts";

let store: Store;

beforeEach(() => {
  store = Store.open({ path: ":memory:" });
});

afterEach(() => {
  store.close();
});

/** Connect an in-process MCP client to a server built WITH write tools enabled. */
async function connectWrite(): Promise<Client> {
  const server = buildMcpServer({
    sqlite: store.connection.sqlite,
    embeddingBackend: "disabled",
    write: { store, config: { connectors: {} } },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** Connect a READ-ONLY server (no write deps). */
async function connectRead(): Promise<Client> {
  const server = buildMcpServer({ sqlite: store.connection.sqlite, embeddingBackend: "disabled" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function parseResult(res: { content: { type: string; text?: string }[] }): unknown {
  return JSON.parse(res.content[0]?.text ?? "");
}

describe("MCP propose / task.create write surface (#12, HITL)", () => {
  test("registers propose.generate / propose.apply / task.create as write tools", async () => {
    const client = await connectWrite();
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of ["propose.generate", "propose.apply", "task.create"]) {
      const tool = byName.get(name);
      expect(tool).toBeDefined();
      // Write tools must be HITL-gated (host requires approval).
      expect(tool?.annotations?.readOnlyHint).toBe(false);
    }
  });

  test("the write tools are absent on a read-only server", async () => {
    const client = await connectRead();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("propose.generate");
    expect(names).not.toContain("propose.apply");
    expect(names).not.toContain("task.create");
  });

  test("propose.generate stamps candidate ids without persisting", async () => {
    const client = await connectWrite();
    const res = await client.callTool({
      name: "propose.generate",
      arguments: {
        mode: "source_extract",
        candidates: [{ kind: "task", title: "ship it", sourceExternalIds: ["gh:1"] }],
      },
    });
    const parsed = parseResult(res as never) as {
      mode: string;
      candidates: { candidateId: string }[];
    };
    expect(parsed.mode).toBe("source_extract");
    expect(parsed.candidates[0]?.candidateId).toMatch(/^cand_/);
    // Nothing persisted by generate.
    const tasks = store.connection.sqlite.query("SELECT * FROM tasks").all();
    expect(tasks).toHaveLength(0);
  });

  test("propose.generate → propose.apply persists, and re-apply is idempotent", async () => {
    const client = await connectWrite();
    const generated = parseResult(
      (await client.callTool({
        name: "propose.generate",
        arguments: {
          mode: "source_extract",
          candidates: [{ kind: "decision", title: "use bun", rationale: "fast" }],
        },
      })) as never,
    ) as { candidates: unknown[] };

    const applied1 = parseResult(
      (await client.callTool({
        name: "propose.apply",
        arguments: { candidates: generated.candidates },
      })) as never,
    ) as { applied: number; skipped: number };
    expect(applied1.applied).toBe(1);

    const applied2 = parseResult(
      (await client.callTool({
        name: "propose.apply",
        arguments: { candidates: generated.candidates },
      })) as never,
    ) as { applied: number; skipped: number };
    expect(applied2.applied).toBe(0);
    expect(applied2.skipped).toBe(1);

    const decisions = store.connection.sqlite.query("SELECT * FROM decisions").all();
    expect(decisions).toHaveLength(1);
  });

  test("propose.generate rejects a candidate kind not allowed for the mode", async () => {
    const client = await connectWrite();
    const res = (await client.callTool({
      name: "propose.generate",
      arguments: {
        mode: "reply_draft",
        candidates: [{ kind: "task", title: "nope" }],
      },
    })) as { isError?: boolean; content: { text?: string }[] };
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain('not valid for mode "reply_draft"');
  });

  test("task.create appends a task and is idempotent", async () => {
    const client = await connectWrite();
    const first = parseResult(
      (await client.callTool({
        name: "task.create",
        arguments: { title: "write the report" },
      })) as never,
    ) as { taskId: string; status: string };
    expect(first.status).toBe("created");

    const second = parseResult(
      (await client.callTool({
        name: "task.create",
        arguments: { title: "write the report" },
      })) as never,
    ) as { status: string };
    expect(second.status).toBe("existing");

    const tasks = store.connection.sqlite.query("SELECT id FROM tasks").all();
    expect(tasks).toHaveLength(1);
  });
});
