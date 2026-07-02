/**
 * MCP host registration snippet for `suasor onboard` step 7 (ADR-0029 §2).
 *
 * The wizard ends by surfacing the `claude_desktop_config.json` block that
 * registers Suasor's stdio MCP server (ADR-0004, the agent boundary). Pure
 * string builder so it is trivially testable and carries no side effect.
 *
 * Like the scheduler template, the snippet's `command` assumes a global `suasor`
 * on PATH. From source (`bun run src/index.ts`) or via `bunx` no such binary
 * exists, so the printed block would register a non-runnable server. We derive
 * the concrete invocation for the detected channel (Issue #388 item 2) and render
 * its `command` + `args` verbatim — mirroring `detectInvocationChannel` /
 * `invocationNote` used for the scheduler block.
 */

import type { InvocationChannel } from "./invocation.ts";

/** A resolved MCP-server invocation: the host `command` plus its full `args`. */
export interface McpInvocation {
  /** Executable the host spawns (e.g. `suasor`, `bun`, `bunx`). */
  readonly command: string;
  /** Full argument vector, e.g. `["mcp", "serve"]` or `["run", "<abs>", "mcp", "serve"]`. */
  readonly args: readonly string[];
}

/**
 * Map the detected invocation channel to the concrete `mcp serve` invocation.
 *
 * - `global`: `suasor mcp serve` (a real binary on PATH — the default the
 *   template has always assumed).
 * - `from-source`: `bun run <entry> mcp serve`, where `entry` is the absolute
 *   path to the source entry (`process.argv[1]`, e.g. `<repo>/src/index.ts`).
 * - `bunx`: `bunx suasor mcp serve`.
 *
 * Pure and injectable (the channel + entry are passed in) so the mapping is
 * unit-testable without depending on how the process itself was launched.
 */
export function resolveMcpInvocation(channel: InvocationChannel, entry: string): McpInvocation {
  if (channel === "from-source") {
    return { command: "bun", args: ["run", entry, "mcp", "serve"] };
  }
  if (channel === "bunx") {
    return { command: "bunx", args: ["suasor", "mcp", "serve"] };
  }
  return { command: "suasor", args: ["mcp", "serve"] };
}

/**
 * Render the `claude_desktop_config.json` MCP registration block for the given
 * invocation. `command` / `args` are JSON-encoded (so absolute Windows paths and
 * other special characters stay valid JSON).
 */
export function renderMcpSnippet(invocation: McpInvocation): string {
  const argsJson = invocation.args.map((a) => JSON.stringify(a)).join(", ");
  return [
    "{",
    '  "mcpServers": {',
    '    "suasor": {',
    `      "command": ${JSON.stringify(invocation.command)},`,
    `      "args": [${argsJson}]`,
    "    }",
    "  }",
    "}",
  ].join("\n");
}
