/**
 * Start the Suasor MCP server over stdio (ADR-0004).
 *
 * Opens the local store, builds the read-tool surface (server.ts), and connects
 * a `StdioServerTransport`. stdout carries only JSON-RPC frames — diagnostics go
 * to stderr — so the protocol framing stays intact for the host process.
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

  const store = Store.open({ path: dbPath });
  const server = buildMcpServer({
    sqlite: store.connection.sqlite,
    embeddingBackend: config.embedding.backend,
  });

  const transport = new StdioServerTransport();
  // Close the store when the transport tears down (host disconnect / SIGINT).
  transport.onclose = () => {
    store.close();
  };

  await server.connect(transport);
  log("suasor mcp serve: listening on stdio (read tools; ADR-0004).");

  // Keep the process alive until the transport closes.
  await new Promise<void>((resolve) => {
    const finish = () => resolve();
    transport.onclose = () => {
      store.close();
      finish();
    };
  });
}
