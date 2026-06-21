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
import { type Config, collectConfigWarnings, loadConfig } from "../config/index.ts";
import type { SecretStoreOptions } from "../connectors/secrets.ts";
import { resolveSelfUserIds } from "../connectors/slack.ts";
import { Store } from "../db/index.ts";
import {
  createEmbedderResolved,
  type Embedder,
  resolveEmbeddingApiKeyPresent,
} from "../retrieval/embedding/index.ts";
import { McpToolError, verifyReadiness } from "./errors.ts";
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
  buildServer?: (args: {
    store: ServeStore;
    config: Config;
    embedder?: Embedder | null;
  }) => ServeServer;
  /**
   * Test seam: secret store options (env / keychain) for resolving an external
   * embedding backend's API key. Defaults to the real env + OS keychain; tests
   * inject an in-memory keychain so boot never touches the native keyring.
   */
  secrets?: SecretStoreOptions;
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
function defaultBuildServer({
  store,
  config,
  embedder,
}: {
  store: ServeStore;
  config: Config;
  embedder?: Embedder | null;
}): ServeServer {
  return buildMcpServer({
    sqlite: store.connection.sqlite,
    // Full [embedding] config drives recall.search (real vec0 search when a
    // backend is enabled, else graceful degrade to FTS — ADR-0005/0006).
    embedding: config.embedding,
    // Pre-resolved embedder: for external backends (openai/voyage) the API key
    // is resolved (keychain/env) before boot, so `recall.search` runs real
    // semantic search; `undefined` lets buildMcpServer build from `embedding`.
    ...(embedder !== undefined ? { embedder } : {}),
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

  // Startup readiness: validate critical config (DB path) before opening
  // anything, so a fatal mis-config fails fast with a structured code/hint
  // instead of crashing deep inside a later tool call (ADR-0031, Issue #196).
  const issues = verifyReadiness(config);
  if (issues.length > 0) {
    // Surface every issue on stderr (diagnostics, never the JSON-RPC stream),
    // then throw the first as a structured error so the host gets code + hint.
    for (const issue of issues) {
      log(`suasor mcp serve: readiness check failed [${issue.code}]: ${issue.message}`);
      log(`  hint: ${issue.hint}`);
    }
    const first = issues[0];
    if (first === undefined) {
      // Unreachable (length > 0), but keeps the type honest without a cast.
      throw new McpToolError("CONFIG_INVALID", "readiness check failed");
    }
    throw new McpToolError(first.code, first.message, first.hint);
  }

  // Resolve the embedder + the external-backend key presence once, in parallel,
  // before wiring the transport (a single await point keeps boot ordering tight).
  // For external backends `createEmbedderResolved` reads the API key (keychain/
  // env) so recall.search runs real semantic search; a missing key yields a null
  // embedder (FTS fallback). `resolveEmbeddingApiKeyPresent` is `true` for
  // non-external backends (no key needed), so the warning below only fires for an
  // external backend with no key.
  const secrets = options.secrets ?? {};
  const [embedder, embeddingApiKeyPresent] = await Promise.all([
    createEmbedderResolved(config.embedding, { secrets }),
    resolveEmbeddingApiKeyPresent(config.embedding.backend, secrets),
  ]);

  // Non-fatal config warnings: keys accepted by the schema but silently dropped
  // at runtime (external embedding backend with no API key → FTS fallback;
  // set-but-unused [llm] backend). Surfaced on stderr (never the JSON-RPC stream)
  // so the operator sees the no-op at boot rather than only via `doctor`
  // (ADR-0007).
  for (const warning of collectConfigWarnings({ ...config, embeddingApiKeyPresent })) {
    log(`suasor mcp serve: config warning [${warning.key}]: ${warning.message}`);
  }

  // verifyReadiness guarantees dbPath is non-null here; assert for the type.
  const dbPath = config.storage.dbPath as string;
  const store = openStore({ path: dbPath, embeddingDim: config.embedding.dim });
  const server = buildServer({ store, config, embedder });
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
