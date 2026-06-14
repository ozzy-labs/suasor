/** MCP module: the agent boundary read surface (ADR-0004, docs/design/mcp-surface.md). */
export {
  type DecisionRecord,
  DEFAULT_LIST_LIMIT,
  getSource,
  type InboxRecord,
  type ListDecisionsOptions,
  type ListInboxOptions,
  type ListSourcesOptions,
  type ListTasksOptions,
  listDecisions,
  listInbox,
  listSources,
  listTasks,
  type SourceRecord,
  type TaskRecord,
  type TimeRange,
} from "./queries.ts";
export { buildMcpServer, EMBEDDING_DISABLED_SIGNAL, type McpServerDeps } from "./server.ts";
export { serveMcp, type ServeOptions } from "./serve.ts";
