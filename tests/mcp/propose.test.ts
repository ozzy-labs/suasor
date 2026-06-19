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
    embedding: "disabled",
    write: { store, config: { connectors: {} } },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** Connect a READ-ONLY server (no write deps). */
async function connectRead(): Promise<Client> {
  const server = buildMcpServer({ sqlite: store.connection.sqlite, embedding: "disabled" });
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

  test("propose.list is a read tool present on read-only and write servers", async () => {
    const writeClient = await connectWrite();
    const writeTool = (await writeClient.listTools()).tools.find((t) => t.name === "propose.list");
    expect(writeTool).toBeDefined();
    expect(writeTool?.annotations?.readOnlyHint).toBe(true);

    const readClient = await connectRead();
    const readNames = (await readClient.listTools()).tools.map((t) => t.name);
    expect(readNames).toContain("propose.list");
  });

  test("propose.reject is a HITL write tool, absent on read-only servers", async () => {
    const writeClient = await connectWrite();
    const tool = (await writeClient.listTools()).tools.find((t) => t.name === "propose.reject");
    expect(tool).toBeDefined();
    expect(tool?.annotations?.readOnlyHint).toBe(false);

    const readClient = await connectRead();
    expect((await readClient.listTools()).tools.map((t) => t.name)).not.toContain("propose.reject");
  });

  test("generate → list (pending) → apply → list (applied) over MCP", async () => {
    const client = await connectWrite();
    const generated = parseResult(
      (await client.callTool({
        name: "propose.generate",
        arguments: {
          mode: "source_extract",
          candidates: [{ kind: "task", title: "lifecycle task" }],
        },
      })) as never,
    ) as { candidates: { candidateId: string }[] };

    const pending = parseResult(
      (await client.callTool({
        name: "propose.list",
        arguments: { state: "pending" },
      })) as never,
    ) as { proposals: { candidateId: string; state: string }[] };
    expect(pending.proposals).toHaveLength(1);
    expect(pending.proposals[0]?.candidateId).toBe(generated.candidates[0]?.candidateId);

    await client.callTool({
      name: "propose.apply",
      arguments: { candidates: generated.candidates },
    });

    const applied = parseResult(
      (await client.callTool({
        name: "propose.list",
        arguments: { state: "applied" },
      })) as never,
    ) as { proposals: unknown[] };
    expect(applied.proposals).toHaveLength(1);
    expect(
      (
        parseResult(
          (await client.callTool({
            name: "propose.list",
            arguments: { state: "pending" },
          })) as never,
        ) as { proposals: unknown[] }
      ).proposals,
    ).toHaveLength(0);
  });

  test("generate → reject → list (rejected), and re-apply is blocked over MCP", async () => {
    const client = await connectWrite();
    const generated = parseResult(
      (await client.callTool({
        name: "propose.generate",
        arguments: { mode: "source_extract", candidates: [{ kind: "task", title: "reject me" }] },
      })) as never,
    ) as { candidates: { candidateId: string }[] };
    const cid = generated.candidates[0]?.candidateId as string;

    const rejected = parseResult(
      (await client.callTool({
        name: "propose.reject",
        arguments: { candidateId: cid, reason: "not now" },
      })) as never,
    ) as { status: string };
    expect(rejected.status).toBe("rejected");

    const listed = parseResult(
      (await client.callTool({ name: "propose.list", arguments: { state: "rejected" } })) as never,
    ) as { proposals: { reason: string }[] };
    expect(listed.proposals).toHaveLength(1);
    expect(listed.proposals[0]?.reason).toBe("not now");

    // A rejected candidate's ledger stays rejected even if apply is attempted.
    await client.callTool({
      name: "propose.apply",
      arguments: { candidates: generated.candidates },
    });
    const after = parseResult(
      (await client.callTool({ name: "propose.list", arguments: {} })) as never,
    ) as { proposals: { state: string }[] };
    expect(after.proposals.every((p) => p.state === "rejected")).toBe(true);
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
