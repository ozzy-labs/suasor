/**
 * Elicitation defense-in-depth ([boundary/hitl-1] / ADR-0004).
 *
 * The irreversible/egress write subset (source.forget, task.publish, task.act,
 * person.merge, propose.apply publish:true) issues a server-side `elicitInput`
 * confirmation WHEN the client advertises the elicitation capability:
 *   - accept + confirm:true → the action proceeds,
 *   - decline / cancel / confirm:false → CONFIRMATION_DECLINED (nothing happens),
 *   - no elicitation capability → fall back to current behavior + a startup
 *     warning (emitted once on connect).
 * A local (non-egress) action such as propose.apply without publish is NOT gated.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Store } from "../../src/db/index.ts";
import { buildMcpServer } from "../../src/mcp/server.ts";

let store: Store;
beforeEach(() => {
  store = Store.open({ path: ":memory:" });
});
afterEach(() => {
  store.close();
});

type ElicitReply = { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> };

function seedSource(externalId = "gh:1", body = "secret plans") {
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

/**
 * Connect a client to a write-enabled server. When `elicit` is given the client
 * advertises the elicitation capability and answers each round-trip via it (also
 * counting how many times it was asked). `log` captures server diagnostics.
 */
async function connect(opts: {
  elicit?: (message: string) => ElicitReply;
  log?: (m: string) => void;
  connectors?: Record<string, Record<string, unknown>>;
}): Promise<{ client: Client; elicitCalls: () => number }> {
  const server = buildMcpServer({
    sqlite: store.connection.sqlite,
    embedding: "disabled",
    ...(opts.log ? { log: opts.log } : {}),
    write: { store, config: { connectors: opts.connectors ?? {} } },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "test", version: "0.0.0" },
    opts.elicit ? { capabilities: { elicitation: { form: {} } } } : undefined,
  );
  let calls = 0;
  if (opts.elicit) {
    const reply = opts.elicit;
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      calls += 1;
      return reply(req.params.message);
    });
  }
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, elicitCalls: () => calls };
}

function parseResult(res: { content: { type: string; text?: string }[] }): unknown {
  return JSON.parse(res.content[0]?.text ?? "");
}

function sourceExists(externalId: string): boolean {
  return (
    store.connection.sqlite.query("SELECT 1 FROM sources WHERE external_id = ?").get(externalId) !==
    null
  );
}

describe("elicitation defense-in-depth ([boundary/hitl-1])", () => {
  test("an elicitation-capable client confirming lets source.forget proceed", async () => {
    seedSource();
    const { client, elicitCalls } = await connect({
      elicit: () => ({ action: "accept", content: { confirm: true } }),
    });
    const out = parseResult(
      (await client.callTool({
        name: "source.forget",
        arguments: { externalId: "gh:1" },
      })) as never,
    ) as { status: string };
    expect(out.status).toBe("forgotten");
    expect(elicitCalls()).toBe(1);
    expect(sourceExists("gh:1")).toBe(false);
  });

  test("declining the confirmation aborts source.forget (CONFIRMATION_DECLINED, source intact)", async () => {
    seedSource();
    const { client } = await connect({ elicit: () => ({ action: "decline" }) });
    const res = (await client.callTool({
      name: "source.forget",
      arguments: { externalId: "gh:1" },
    })) as { isError?: boolean; content: { type: string; text?: string }[] };
    expect(res.isError).toBe(true);
    expect((parseResult(res) as { code: string }).code).toBe("CONFIRMATION_DECLINED");
    // The source was NOT forgotten.
    expect(sourceExists("gh:1")).toBe(true);
  });

  test("accept with confirm:false is treated as declined", async () => {
    seedSource();
    const { client } = await connect({
      elicit: () => ({ action: "accept", content: { confirm: false } }),
    });
    const res = (await client.callTool({
      name: "source.forget",
      arguments: { externalId: "gh:1" },
    })) as { isError?: boolean; content: { type: string; text?: string }[] };
    expect(res.isError).toBe(true);
    expect((parseResult(res) as { code: string }).code).toBe("CONFIRMATION_DECLINED");
    expect(sourceExists("gh:1")).toBe(true);
  });

  test("a client WITHOUT the elicitation capability falls back to current behavior (proceeds)", async () => {
    seedSource();
    const { client, elicitCalls } = await connect({}); // no capability, no handler
    const out = parseResult(
      (await client.callTool({
        name: "source.forget",
        arguments: { externalId: "gh:1" },
      })) as never,
    ) as { status: string };
    expect(out.status).toBe("forgotten");
    expect(elicitCalls()).toBe(0);
    expect(sourceExists("gh:1")).toBe(false);
  });

  test("person.merge is gated: declining aborts before any merge", async () => {
    const { client, elicitCalls } = await connect({ elicit: () => ({ action: "cancel" }) });
    const res = (await client.callTool({
      name: "person.merge",
      arguments: { targetPersonId: "p1", sourcePersonId: "p2" },
    })) as { isError?: boolean; content: { type: string; text?: string }[] };
    expect(res.isError).toBe(true);
    // Declined before personMerge runs → CONFIRMATION_DECLINED, not MISSING_ENTITY.
    expect((parseResult(res) as { code: string }).code).toBe("CONFIRMATION_DECLINED");
    expect(elicitCalls()).toBe(1);
  });

  test("a LOCAL propose.apply (no publish) is NOT gated even for an elicitation-capable client", async () => {
    const { client, elicitCalls } = await connect({
      elicit: () => ({ action: "accept", content: { confirm: true } }),
    });
    // Generate a candidate first (also not gated), then apply locally.
    const generated = parseResult(
      (await client.callTool({
        name: "propose.generate",
        arguments: { mode: "source_extract", candidates: [{ kind: "task", title: "local apply" }] },
      })) as never,
    ) as { candidates: unknown[] };
    const applied = parseResult(
      (await client.callTool({
        name: "propose.apply",
        arguments: { candidates: generated.candidates },
      })) as never,
    ) as { applied: number };
    expect(applied.applied).toBe(1);
    // No elicitInput round-trip for a local (non-egress) apply.
    expect(elicitCalls()).toBe(0);
  });

  test("a startup warning is emitted once when the client lacks the elicitation capability", async () => {
    const logs: string[] = [];
    const { client } = await connect({ log: (m) => logs.push(m) });
    // Force the handshake (incl. the initialized notification) to settle.
    await client.listTools();
    expect(logs.some((m) => m.includes("does not advertise the elicitation capability"))).toBe(
      true,
    );
  });

  test("no startup warning when the client advertises elicitation", async () => {
    const logs: string[] = [];
    const { client } = await connect({
      log: (m) => logs.push(m),
      elicit: () => ({ action: "accept", content: { confirm: true } }),
    });
    await client.listTools();
    expect(logs.some((m) => m.includes("does not advertise the elicitation capability"))).toBe(
      false,
    );
  });
});
