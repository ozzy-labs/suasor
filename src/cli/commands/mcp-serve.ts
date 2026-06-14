/**
 * `suasor mcp serve` — start the MCP server over stdio (ADR-0004).
 *
 * Stub: the MCP surface (read/write tools, HITL boundary) is implemented by a
 * downstream Issue (docs/design/mcp-surface.md). This command is wired into the
 * CLI now so the command surface is stable; it prints a pending notice and
 * exits without starting a server.
 */
import { Command } from "clipanion";

export class McpServeCommand extends Command {
  static override paths = [["mcp", "serve"]];

  static override usage = Command.Usage({
    category: "MCP",
    description: "Start the MCP server over stdio (not yet implemented).",
    details: `
      Will expose Suasor's read/write tools over MCP (stdio transport), with the
      HITL boundary enforced on write tools (ADR-0004, docs/design/mcp-surface.md).
      Wired by a downstream Issue; currently a stub.
    `,
    examples: [["Start the MCP server", "suasor mcp serve"]],
  });

  override async execute(): Promise<number> {
    this.context.stderr.write(
      "suasor mcp serve: not yet implemented (wired by a later Issue; see docs/design/mcp-surface.md).\n",
    );
    return 0;
  }
}
