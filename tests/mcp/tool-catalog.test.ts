/**
 * MCP tool-catalog drift guard (docs/design/mcp-surface.md).
 *
 * `src/mcp/tool-catalog.ts` is the data view that `suasor mcp tools` prints
 * without starting a server. This test pins it to the tools an actual server
 * registers — name *and* readOnlyHint must match exactly, for both the
 * write-enabled (full) surface and the read-only deployment — so the offline
 * listing can never silently drift from `mcp serve`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../../src/db/index.ts";
import { buildMcpServer } from "../../src/mcp/server.ts";
import { mcpToolCatalog } from "../../src/mcp/tool-catalog.ts";

let store: Store;

beforeEach(() => {
  store = Store.open({ path: ":memory:" });
});

afterEach(() => {
  store.close();
});

/** List the registered tools from a server, as `{ name, readOnlyHint }`. */
async function registeredTools(
  withWrite: boolean,
): Promise<{ name: string; readOnlyHint: boolean }[]> {
  const server = buildMcpServer({
    sqlite: store.connection.sqlite,
    embedding: "disabled",
    ...(withWrite ? { write: { store, config: { connectors: {} } } } : {}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  return tools.map((t) => ({ name: t.name, readOnlyHint: t.annotations?.readOnlyHint === true }));
}

/** Sort by name for order-independent comparison. */
function byName<T extends { name: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name));
}

describe("MCP tool catalog ↔ server registration", () => {
  test("full (write-enabled) catalog matches the registered tools", async () => {
    const registered = byName(await registeredTools(true));
    const catalog = byName(
      mcpToolCatalog(true).map((t) => ({ name: t.name, readOnlyHint: t.readOnlyHint })),
    );
    expect(catalog).toEqual(registered);
  });

  test("read-only catalog matches a server built without a writable store", async () => {
    const registered = byName(await registeredTools(false));
    const catalog = byName(
      mcpToolCatalog(false).map((t) => ({ name: t.name, readOnlyHint: t.readOnlyHint })),
    );
    expect(catalog).toEqual(registered);
  });

  test("every catalog entry has a non-empty summary", () => {
    for (const t of mcpToolCatalog()) {
      expect(t.summary.length).toBeGreaterThan(0);
    }
  });
});
