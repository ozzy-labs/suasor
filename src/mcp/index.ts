/** MCP module: the agent boundary read surface (ADR-0004, docs/design/mcp-surface.md). */
export {
  DEFAULT_LIST_LIMIT,
  type DecisionRecord,
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
export { type ServeOptions, serveMcp } from "./serve.ts";
export { buildMcpServer, EMBEDDING_DISABLED_SIGNAL, type McpServerDeps } from "./server.ts";
