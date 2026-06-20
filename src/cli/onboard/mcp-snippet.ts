/**
 * MCP host registration snippet for `suasor onboard` step 7 (ADR-0029 §2).
 *
 * The wizard ends by surfacing the `claude_desktop_config.json` block that
 * registers Suasor's stdio MCP server (ADR-0004, the agent boundary). Pure
 * string builder so it is trivially testable and carries no side effect.
 */

/** Render the `claude_desktop_config.json` MCP registration block. */
export function renderMcpSnippet(command = "suasor"): string {
  return [
    "{",
    '  "mcpServers": {',
    '    "suasor": {',
    `      "command": "${command}",`,
    '      "args": ["mcp", "serve"]',
    "    }",
    "  }",
    "}",
  ].join("\n");
}
