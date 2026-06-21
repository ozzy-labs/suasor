/**
 * MCP server factory — the agent boundary (ADR-0004, docs/design/mcp-surface.md).
 *
 * Wires Suasor's tool surface onto an `McpServer` from the official TypeScript
 * SDK and hands it back for the caller to connect a transport. The actual tool
 * registrations live in two focused halves so this file stays small and the
 * read/write split is structural (not just advisory):
 *
 * - `server-read.ts` — the side-effect-free read tools (`search`,
 *   `recall.search`, `search.hybrid`, `source.*`, `task.list`, `decision.list`,
 *   `slack.demand.list`, `brief`, `graph.*`, `inbox.list`, `propose.list`,
 *   `commitment.list`, `person.list`). All `readOnlyHint: true`.
 * - `server-write.ts` — the HITL write tools (`connector.sync`, `propose.*`,
 *   `task.create` / `task.update`, `decision.record`, `inbox.add` /
 *   `inbox.triage`, `link.add` / `link.remove`, `person.merge` / `person.split`,
 *   `commitment.resolve` / `.dismiss` / `.reopen`, `source.forget`,
 *   `draft.export`). All `readOnlyHint: false`; registered only when a writable
 *   `Store` + config are supplied.
 *
 * Shared deps/contract + small helpers live in `server-shared.ts`. The public
 * import path (`./server.ts` → `buildMcpServer`, `McpServerDeps`,
 * `EMBEDDING_DISABLED_SIGNAL`) and the tool registration order are unchanged.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createEmbedder, EMBEDDING_DISABLED_SIGNAL } from "../retrieval/embedding/index.ts";
import { VERSION } from "../version.ts";
import { registerReadTools } from "./server-read.ts";
import { type McpServerDeps, resolveEmbeddingConfig } from "./server-shared.ts";
import { registerWriteTools } from "./server-write.ts";

export type { McpServerDeps };
export { EMBEDDING_DISABLED_SIGNAL };

/**
 * Build the Suasor MCP server with the read tools registered (plus write tools
 * when a writable store is supplied). The caller is responsible for connecting a
 * transport (`server.connect(transport)`).
 */
export function buildMcpServer(deps: McpServerDeps): McpServer {
  const { sqlite, write } = deps;
  const embeddingConfig = resolveEmbeddingConfig(deps.embedding);
  // An injected embedder (tests) wins; otherwise build one from config. `null`
  // means no backend (or an unimplemented one) → recall degrades to FTS.
  const embedder = deps.embedder !== undefined ? deps.embedder : createEmbedder(embeddingConfig);
  const server = new McpServer(
    { name: "suasor", version: VERSION },
    {
      instructions:
        "Suasor local-first work memory (ADR-0004). Read tools (readOnlyHint: " +
        "true) are safe to call autonomously. Default retrieval is `search` " +
        "(FTS5); `recall.search` adds semantic search only when an embedding backend " +
        "is enabled, otherwise it returns the `embedding_disabled` signal so you can " +
        "fall back to `search`. Write tools (readOnlyHint: false — connector.sync, " +
        "propose.generate, propose.apply, propose.reject, propose.batch, task.create, decision.record, " +
        "inbox.add, inbox.triage, link.add, link.remove, commitment.resolve, " +
        "commitment.dismiss, commitment.reopen, person.merge, person.split) are HITL: " +
        "gate them behind human approval, never auto-apply. propose.list (read) shows the " +
        "candidate ledger by state for the approve/reject loop; commitment.list (read) shows " +
        "the commitment ledger by state for the resolve/dismiss/reopen loop; person.list " +
        "(read) shows resolved persons and their connector identities (ADR-0022).",
    },
  );

  // Read tools first (order-sensitive: keeps the tool catalog byte-identical to
  // the pre-split server), then the HITL write tools when a store is supplied.
  registerReadTools(server, { sqlite, embedder, embeddingConfig, deps });
  if (write) {
    registerWriteTools(server, write);
  }

  return server;
}
