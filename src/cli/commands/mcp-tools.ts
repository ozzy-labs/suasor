/**
 * `suasor mcp tools [--json]` — introspect the MCP tool surface without starting
 * a server (ADR-0004, docs/design/mcp-surface.md). Lists every registered tool
 * with its read/write classification (`readOnlyHint`) and a one-line summary,
 * for documentation / smoke-checking the surface.
 *
 * Source of truth is the tool catalog (`src/mcp/tool-catalog.ts`), which a drift
 * test pins to the tools an actual server registers — so this listing cannot
 * silently fall out of sync with `mcp serve`. Both read and write/HITL tools are
 * shown (the write tools are the ones gated behind human approval, ADR-0004).
 *
 * Lazy-import discipline (NFR-PRF-1): the catalog is plain data (no MCP SDK / DB
 * / config), imported inside `execute` so building the command registry stays
 * light.
 */
import { Command, Option } from "clipanion";

export class McpToolsCommand extends Command {
  static override paths = [["mcp", "tools"]];

  static override usage = Command.Usage({
    category: "MCP",
    description: "List the MCP tools (name / read·write / summary) without starting a server.",
    details: `
      Introspects the MCP tool surface (ADR-0004) offline: every registered tool,
      whether it is read-only (readOnlyHint: true — hosts may auto-approve) or a
      write/HITL tool (readOnlyHint: false — gate behind human approval), and a
      one-line summary. Mirrors what 'mcp serve' exposes. Use --json for machine
      output.
    `,
    examples: [
      ["List MCP tools", "suasor mcp tools"],
      ["Machine-readable output", "suasor mcp tools --json"],
    ],
  });

  json = Option.Boolean("--json", false, {
    description: "Emit the tool list as JSON.",
  });

  override async execute(): Promise<number> {
    const { mcpToolCatalog } = await import("../../mcp/tool-catalog.ts");
    const tools = mcpToolCatalog();

    if (this.json) {
      this.context.stdout.write(`${JSON.stringify(tools, null, 2)}\n`);
      return 0;
    }

    const width = tools.reduce((max, t) => Math.max(max, t.name.length), 0);
    for (const t of tools) {
      const kind = t.readOnlyHint ? "read " : "write";
      this.context.stdout.write(`${t.name.padEnd(width)}  ${kind}  ${t.summary}\n`);
    }
    const readCount = tools.filter((t) => t.readOnlyHint).length;
    const writeCount = tools.length - readCount;
    this.context.stdout.write(
      `${tools.length} tool(s): ${readCount} read, ${writeCount} write (HITL).\n`,
    );
    return 0;
  }
}
