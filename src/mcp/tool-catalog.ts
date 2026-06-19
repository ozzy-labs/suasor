/**
 * MCP tool catalog — a **data** view of the tools `buildMcpServer` registers
 * (docs/design/mcp-surface.md). Lets `suasor mcp tools` introspect the surface
 * (name / read·write / one-line summary) **without** starting a server or
 * opening a Store, keeping the CLI cold start light (NFR-PRF-1) and the listing
 * side-effect-free.
 *
 * This module is the single source of truth for the *catalog* (the registration
 * code in `server.ts` stays the source of truth for input schemas + handlers).
 * `tests/mcp/tool-catalog.test.ts` asserts this catalog matches the tools an
 * actual server registers (name, readOnlyHint), so the two cannot drift.
 *
 * Import-clean: declares plain data only — no MCP SDK, DB, or config import.
 */

/** One MCP tool's introspectable metadata. */
export interface McpToolInfo {
  /** Tool name as registered (e.g. "search", "connector.sync"). */
  readonly name: string;
  /**
   * `true` for side-effect-free read tools (hosts may auto-approve); `false` for
   * write/HITL tools (gate behind human approval — no auto-apply, ADR-0004).
   */
  readonly readOnlyHint: boolean;
  /** One-line summary of what the tool does. */
  readonly summary: string;
}

/** Read tools — registered unconditionally, `readOnlyHint: true` (ADR-0004). */
const READ_TOOLS: readonly McpToolInfo[] = [
  { name: "search", readOnlyHint: true, summary: "FTS5 full-text search over ingested sources." },
  {
    name: "recall.search",
    readOnlyHint: true,
    summary: "Semantic (embedding) search; degrades to FTS when no backend is enabled.",
  },
  { name: "source.list", readOnlyHint: true, summary: "List ingested sources newest-first." },
  { name: "source.get", readOnlyHint: true, summary: "Fetch one source (with body) by id." },
  { name: "task.list", readOnlyHint: true, summary: "List tasks, most-recently-updated first." },
  {
    name: "decision.list",
    readOnlyHint: true,
    summary: "List recorded decisions, newest-recorded first.",
  },
  {
    name: "slack.demand.list",
    readOnlyHint: true,
    summary: "List Slack @mentions of you and DMs (derived, read-only).",
  },
  {
    name: "brief",
    readOnlyHint: true,
    summary: "Bundle the period's tasks/decisions/sources/inbox for the host to summarize.",
  },
  {
    name: "graph.related",
    readOnlyHint: true,
    summary: "Provenance neighbours of an entity (1 hop) over the links projection.",
  },
  {
    name: "graph.expand",
    readOnlyHint: true,
    summary: "Breadth-first provenance expansion from an entity (N hops).",
  },
  {
    name: "inbox.list",
    readOnlyHint: true,
    summary: "List inbox items, most-recently-updated first.",
  },
  {
    name: "propose.list",
    readOnlyHint: true,
    summary: "List proposal candidates by state (pending/applied/rejected).",
  },
];

/**
 * Write tools — registered only when a writable store is supplied,
 * `readOnlyHint: false`; HITL (no auto-apply, ADR-0004).
 */
const WRITE_TOOLS: readonly McpToolInfo[] = [
  {
    name: "connector.sync",
    readOnlyHint: false,
    summary: "Run a read-only connector ingest pass into the local store.",
  },
  {
    name: "propose.generate",
    readOnlyHint: false,
    summary: "Frame reply/task/decision/triage candidates and record them as pending.",
  },
  {
    name: "propose.apply",
    readOnlyHint: false,
    summary: "Persist approved candidates as domain events (idempotent).",
  },
  {
    name: "propose.reject",
    readOnlyHint: false,
    summary: "Reject a pending candidate with a reason (idempotent).",
  },
  { name: "task.create", readOnlyHint: false, summary: "Create a task directly (TaskProposed)." },
  {
    name: "decision.record",
    readOnlyHint: false,
    summary: "Record a decision directly (DecisionRecorded).",
  },
  {
    name: "inbox.add",
    readOnlyHint: false,
    summary: "Capture an inbox item referencing a source (InboxItemTriaged, state open).",
  },
  {
    name: "inbox.triage",
    readOnlyHint: false,
    summary: "Resolve an open inbox item (task / decision / discard).",
  },
  {
    name: "link.add",
    readOnlyHint: false,
    summary: "Create a manual provenance link between two entities (LinkAdded, manual_link).",
  },
  {
    name: "link.remove",
    readOnlyHint: false,
    summary: "Remove a manual link by id (LinkRemoved).",
  },
];

/**
 * The MCP tool catalog. When `includeWrite` is `true` (default) the write/HITL
 * tools are appended after the read tools — matching a server built with a
 * writable store. Pass `false` for the read-only deployment view.
 */
export function mcpToolCatalog(includeWrite = true): McpToolInfo[] {
  return includeWrite ? [...READ_TOOLS, ...WRITE_TOOLS] : [...READ_TOOLS];
}
