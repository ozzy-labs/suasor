/**
 * `suasor mcp serve` — start the MCP server over stdio (ADR-0004).
 *
 * Exposes Suasor's read tools (search / recall.search / source.* / task.list /
 * decision.list / inbox.list) over the MCP stdio transport, the agent boundary
 * (docs/design/mcp-surface.md). Read tools have no side effects; write/HITL
 * tools are added by later Issues.
 *
 * Heavy dependencies (MCP SDK, DB layer, config loader) are imported lazily
 * inside `execute` so the CLI cold start stays light (NFR-PRF-1).
 *
 * stdout is reserved for the JSON-RPC stream — diagnostics go to stderr.
 */
import { Command } from "clipanion";

export class McpServeCommand extends Command {
  static override paths = [["mcp", "serve"]];

  static override usage = Command.Usage({
    category: "MCP",
    description: "Start the MCP server over stdio.",
    details: `
      Exposes Suasor's read tools over MCP (stdio transport): search,
      recall.search (returns the embedding_disabled signal until a backend is
      enabled), source.list / source.get, and task.list / decision.list /
      inbox.list. Read tools are side-effect-free; write tools (HITL) are added
      by later Issues (ADR-0004, docs/design/mcp-surface.md).

      Configure an MCP host to launch this command over stdio.
    `,
    examples: [["Start the MCP server", "suasor mcp serve"]],
  });

  override async execute(): Promise<number> {
    const { serveMcp } = await import("../../mcp/index.ts");
    try {
      await serveMcp({ log: (m) => this.context.stderr.write(`${m}\n`) });
      return 0;
    } catch (error) {
      this.context.stderr.write(`suasor mcp serve: ${(error as Error).message}\n`);
      return 1;
    }
  }
}
