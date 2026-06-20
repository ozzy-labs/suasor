/**
 * Start the Suasor MCP server over stdio (ADR-0004).
 *
 * Opens the local store, builds the tool surface (server.ts: read tools plus
 * the `connector.sync` write tool, HITL), and connects a `StdioServerTransport`.
 * stdout carries only JSON-RPC frames — diagnostics go to stderr — so the
 * protocol framing stays intact for the host process.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type Config, loadConfig } from "../config/index.ts";
import { resolveSelfUserIds } from "../connectors/slack.ts";
import { Store } from "../db/index.ts";
import { buildMcpServer } from "./server.ts";

/** Minimal store contract `serveMcp` relies on (connection handle + close). */
export interface ServeStore {
  connection: { sqlite: Store["connection"]["sqlite"] };
  close(): void;
}

/** Minimal server contract `serveMcp` relies on (connect a transport). */
export interface ServeServer {
  connect(transport: Transport): Promise<void>;
}

export interface ServeOptions {
  /** Where diagnostics (never protocol frames) are written. Defaults to stderr. */
  log?: (message: string) => void;
  /**
   * Test seam: resolve the effective config. Defaults to {@link loadConfig}.
   */
  loadConfig?: () => Promise<Config>;
  /**
   * Test seam: open the store for a resolved dbPath. Defaults to
   * {@link Store.open}. Keeps real boots opening a real on-disk store.
   */
  openStore?: (options: { path: string; embeddingDim: number }) => ServeStore;
  /**
   * Test seam: build the MCP server from the open store + config. Defaults to
   * {@link buildMcpServer}.
   */
  buildServer?: (args: { store: ServeStore; config: Config }) => ServeServer;
  /**
   * Test seam: the transport to connect. Defaults to a real
   * `StdioServerTransport`; tests inject a fake so stdio is never touched.
   */
  transport?: Transport;
}

/** Default store opener — a thin wrapper so the seam stays type-aligned. */
function defaultOpenStore(options: { path: string; embeddingDim: number }): ServeStore {
  return Store.open(options);
}

/** Default server builder — wires the open store + config into the tool surface. */
function defaultBuildServer({ store, config }: { store: ServeStore; config: Config }): ServeServer {
  return buildMcpServer({
    sqlite: store.connection.sqlite,
    // Full [embedding] config drives recall.search (real vec0 search when a
    // backend is enabled, else graceful degrade to FTS — ADR-0005/0006).
    embedding: config.embedding,
    // Operator user ids for slack.demand.list @mention detection (ADR-0012).
    slackSelfUserIds: resolveSelfUserIds(config.connectors.slack ?? {}),
    // Whether [connectors.slack] is configured at all — drives the brief
    // `slack_not_configured` completeness signal (Issue #189), independent of
    // whether a self_user_id is set.
    slackConfigured: config.connectors.slack !== undefined,
    // Enable the `connector.sync` write tool (HITL) over the same store
    // (ADR-0007 / Issue #10 D5). The `[embedding]` config in `config` also lets
    // ingest (re)populate vec0. Hosts gate the write via `readOnlyHint: false`.
    write: { store: store as Store, config },
  });
}

/**
 * Boot the MCP stdio server. Resolves once the transport closes (the host
 * disconnects). Diagnostics are written via `log` (stderr by default); stdout is
 * reserved for the JSON-RPC stream.
 *
 * All non-`log` options are test seams; the no-arg behavior is identical to a
 * real boot (real config / store / server / stdio transport).
 */
export async function serveMcp(options: ServeOptions = {}): Promise<void> {
  const log = options.log ?? ((m: string) => process.stderr.write(`${m}\n`));
  const load = options.loadConfig ?? loadConfig;
  const openStore = options.openStore ?? defaultOpenStore;
  const buildServer = options.buildServer ?? defaultBuildServer;

  const config = await load();
  const dbPath = config.storage.dbPath;
  if (dbPath === null) {
    throw new Error("storage.dbPath is not configured");
  }

  const store = openStore({ path: dbPath, embeddingDim: config.embedding.dim });
  const server = buildServer({ store, config });
  const transport = options.transport ?? new StdioServerTransport();

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
