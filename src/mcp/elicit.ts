/**
 * Defense-in-depth confirmation for irreversible / egress write tools
 * (ADR-0004, [boundary/hitl-1]).
 *
 * HITL is host-enforced: `readOnlyHint: false` is an *advisory* MCP annotation,
 * not a server-side gate, so a host configured to auto-approve can drive a write
 * with no human in the loop. For the small subset of tools that are irreversible
 * (local purge) or egress off the machine (external publish / write-back), the
 * server additionally issues an `elicitInput` confirmation round-trip WHEN the
 * client advertises the elicitation capability — raising the bar against
 * auto-approve configs.
 *
 * This is NOT a server-enforceable guarantee: the elicitation response is also
 * produced by the client, so a host that auto-answers could bypass it too —
 * nothing in MCP can create a server-held human guarantee (that unenforceability
 * is inherent to choosing MCP as the boundary, ADR-0004). When the client does
 * not advertise elicitation, the server falls back to the current behavior
 * (proceed) plus a one-time startup warning (wired in `buildMcpServer`).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Tools that get the extra `elicitInput` confirmation (irreversible / egress
 * subset, ADR-0004). `propose.apply` is gated only when `publish: true` (the
 * egress path); a local-only apply is not gated.
 */
export const ELICITATION_GATED_TOOLS = [
  "source.forget",
  "task.publish",
  "task.act",
  "person.merge",
  "propose.apply",
] as const;

/** Outcome of a confirmation attempt. */
export interface ElicitDecision {
  /** Whether the connected client advertises the elicitation capability. */
  supported: boolean;
  /** Whether the action may proceed (always true when unsupported: fallback). */
  proceed: boolean;
}

/** True when the connected client advertises the MCP elicitation capability. */
export function clientSupportsElicitation(server: McpServer): boolean {
  return server.server.getClientCapabilities()?.elicitation != null;
}

/**
 * Ask the human to confirm an irreversible/egress action via `elicitInput`.
 *
 * - Client advertises elicitation → proceed only on an explicit `accept` +
 *   `confirm: true`; a decline / cancel / `confirm: false` aborts the action.
 * - Client does NOT advertise elicitation → no round-trip; returns
 *   `{ supported: false, proceed: true }` (fallback to current behavior). The
 *   startup warning about the missing capability is emitted once at connect
 *   time (see `buildMcpServer`), not per call.
 */
export async function confirmSensitiveAction(
  server: McpServer,
  opts: { tool: string; summary: string },
): Promise<ElicitDecision> {
  if (!clientSupportsElicitation(server)) {
    return { supported: false, proceed: true };
  }
  let result: Awaited<ReturnType<McpServer["server"]["elicitInput"]>>;
  try {
    result = await server.server.elicitInput({
      message: `Confirm ${opts.tool}: ${opts.summary}`,
      requestedSchema: {
        type: "object",
        properties: {
          confirm: {
            type: "boolean",
            title: "Proceed?",
            description: `Run ${opts.tool}. This is irreversible or sends data off this machine.`,
          },
        },
        required: ["confirm"],
      },
    });
  } catch {
    // The client advertised elicitation but the round-trip is unusable (e.g. it
    // supports only URL mode, not the form mode used here, or the request
    // failed). Fail open to the current behavior rather than block a legitimate
    // write on a capability quirk — this is best-effort defense-in-depth, not a
    // hard gate (ADR-0004; MCP cannot server-enforce a human anyway).
    return { supported: false, proceed: true };
  }
  const proceed = result.action === "accept" && result.content?.confirm === true;
  return { supported: true, proceed };
}
