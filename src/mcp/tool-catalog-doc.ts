/**
 * README tool-list renderer — turns the {@link mcpToolCatalog} data view into
 * the Markdown block embedded in `README.md` / `README.ja.md`.
 *
 * The READMEs used to hand-list a handful of write tools, which silently drifted
 * from the real surface (ADR-0036 shipped actuators — `task.publish` / `task.act`
 * — that the list never mentioned). Generating the block from the single catalog
 * keeps the docs honest by construction: `scripts/gen-readme-tools.ts` writes it,
 * and `tests/mcp/tool-catalog-doc.test.ts` fails if either README goes stale.
 *
 * Import-clean: depends only on the catalog data (no MCP SDK / DB / fs).
 */
import { type McpToolInfo, mcpToolCatalog } from "./tool-catalog.ts";

/** Full opening marker written into the README (identifies the generated span). */
export const MCP_TOOLS_BEGIN =
  "<!-- BEGIN GENERATED mcp-tools — source: src/mcp/tool-catalog.ts; regenerate with `bun run gen:readme-tools`. DO NOT EDIT BY HAND. -->";
/** Closing marker. */
export const MCP_TOOLS_END = "<!-- END GENERATED mcp-tools -->";
/** Stable prefix used to locate the opening marker for in-place replacement. */
export const MCP_TOOLS_BEGIN_PREFIX = "<!-- BEGIN GENERATED mcp-tools";

const READ_INTRO =
  "**Read tools** — side-effect-free (`readOnlyHint: true`), so hosts may auto-approve them:";

const WRITE_INTRO =
  "**Write tools** — every one is HITL: a host must gate it behind human approval, and there is no auto-apply path ([ADR-0004](docs/adr/0004-mcp-agent-boundary-and-hitl.md)). The set includes **actuators** that carry out an approved action on your behalf — `task.publish` / `task.act` / `task.update` egress to your GitHub / Jira / Slack task home ([ADR-0036](docs/adr/0036-task-external-home.md)) — and `source.forget`, which irreversibly purges an ingested source. Suasor never triggers any of these on its own; you approve each one first:";

function bullet(tool: McpToolInfo): string {
  return `- \`${tool.name}\` — ${tool.summary}`;
}

/**
 * Render the read/write tool bullets from the catalog, without the surrounding
 * HTML markers. Read tools first, then write tools, each in catalog order.
 */
export function renderMcpToolsBody(): string {
  const catalog = mcpToolCatalog(true);
  const read = catalog.filter((tool) => tool.readOnlyHint).map(bullet);
  const write = catalog.filter((tool) => !tool.readOnlyHint).map(bullet);
  return [READ_INTRO, "", ...read, "", WRITE_INTRO, "", ...write].join("\n");
}

/**
 * Render the complete generated block (opening marker … tool bullets … closing
 * marker) exactly as it must appear in the README files. The generator writes
 * this verbatim and the drift test compares against it byte-for-byte.
 */
export function renderMcpToolsBlock(): string {
  return `${MCP_TOOLS_BEGIN}\n\n${renderMcpToolsBody()}\n\n${MCP_TOOLS_END}`;
}
