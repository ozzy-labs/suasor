/**
 * Start the Suasor MCP server over stdio (ADR-0004).
 *
 * Opens the local store, builds the tool surface (server.ts: read tools plus
 * the `connector.sync` write tool, HITL), and connects a `StdioServerTransport`.
 * stdout carries only JSON-RPC frames — diagnostics go to stderr — so the
 * protocol framing stays intact for the host process.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../config/index.ts";
import { Store } from "../db/index.ts";
import { buildMcpServer } from "./server.ts";

export interface ServeOptions {
  /** Where diagnostics (never protocol frames) are written. Defaults to stderr. */
  log?: (message: string) => void;
}

/**
 * Boot the MCP stdio server. Resolves once the transport closes (the host
 * disconnects). Diagnostics are written via `log` (stderr by default); stdout is
 * reserved for the JSON-RPC stream.
 */
export async function serveMcp(options: ServeOptions = {}): Promise<void> {
  const log = options.log ?? ((m: string) => process.stderr.write(`${m}\n`));

  const config = await loadConfig();
  const dbPath = config.storage.dbPath;
  if (dbPath === null) {
    throw new Error("storage.dbPath is not configured");
  }

  const store = Store.open({ path: dbPath, embeddingDim: config.embedding.dim });
  const server = buildMcpServer({
    sqlite: store.connection.sqlite,
    // Full [embedding] config drives recall.search (real vec0 search when a
    // backend is enabled, else graceful degrade to FTS — ADR-0005/0006).
    embedding: config.embedding,
    // Enable the `connector.sync` write tool (HITL) over the same store
    // (ADR-0007 / Issue #10 D5). The `[embedding]` config in `config` also lets
    // ingest (re)populate vec0. Hosts gate the write via `readOnlyHint: false`.
    write: { store, config },
  });

  const transport = new StdioServerTransport();

  // Resolve when the transport tears down (host disconnect / stdin EOF). The
  // handler is wired *before* connect so a fast close can't be missed, and the
  // store is closed exactly once.
  await new Promise<void>((resolve, reject) => {
    let closed = false;
    transport.onclose = () => {
      if (closed) return;
      closed = true;
      store.close();
      resolve();
    };

    server.connect(transport).then(
      () => log("suasor mcp serve: listening on stdio (read tools + connector.sync; ADR-0004)."),
      (error) => {
        if (!closed) {
          closed = true;
          store.close();
        }
        reject(error);
      },
    );
  });
}
