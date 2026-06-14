/**
 * `connector.sync` MCP write tool (HITL, ADR-0004 / docs/design/mcp-surface.md).
 *
 * Ingest is a **write tool**: it mutates the local store, so the host must gate
 * it behind human approval (no auto-apply path). The handler calls the exact
 * same `syncConnector` service as the `suasor <connector> sync` CLI, so both
 * entry points behave identically (Issue #10 追補 D5).
 *
 * Exposed as a self-contained descriptor (name + Zod input schema + handler).
 * The MCP server (`src/mcp/server.ts`) registers `connector.sync` over this
 * `runConnectorSyncTool` handler when a writable store is supplied; keeping the
 * contract here lets the connector own its tool shape and keeps the service
 * layer shared with the CLI. Import-clean: only `zod` + contract/registry types
 * at the top level; the store and SDK load lazily via the registry/service.
 */
import { z } from "zod";
import type { Store } from "../db/index.ts";
import { type SecretStoreOptions, syncConnector } from "./index.ts";
import { loadConnector } from "./registry.ts";

/** MCP tool name (dotted, matching docs/design/mcp-surface.md). */
export const CONNECTOR_SYNC_TOOL_NAME = "connector.sync";

/** Input schema for `connector.sync` (Zod, per MCP surface convention). */
export const ConnectorSyncInput = z.object({
  /** Connector to run (e.g. "github"). */
  connector: z.string().min(1),
  /**
   * Resume cursor override. Omit to resume from the last persisted cursor;
   * pass `null` to force a full re-scan.
   */
  cursor: z.string().nullable().optional(),
});
export type ConnectorSyncInput = z.infer<typeof ConnectorSyncInput>;

/** Output of `connector.sync` (counts + next cursor). */
export const ConnectorSyncOutput = z.object({
  connector: z.string(),
  observed: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  cursor: z.string().nullable(),
});
export type ConnectorSyncOutput = z.infer<typeof ConnectorSyncOutput>;

/** Resolve the `[connectors.<name>]` config slice from the loaded config. */
function connectorConfigSlice(
  config: { connectors: Record<string, Record<string, unknown>> },
  name: string,
): Record<string, unknown> {
  return config.connectors[name] ?? {};
}

export interface ConnectorSyncDeps {
  /** Open store the sync writes to (host supplies the configured DB). */
  store: Store;
  /** Effective config (provides the `[connectors.<name>]` slice). */
  config: { connectors: Record<string, Record<string, unknown>> };
  /** Secret backend override (tests inject; defaults to env + keychain). */
  secrets?: SecretStoreOptions;
}

/**
 * Run `connector.sync`. The host (MCP server) is responsible for HITL approval
 * before invoking this; the function itself performs the (approved) write.
 */
export async function runConnectorSyncTool(
  input: ConnectorSyncInput,
  deps: ConnectorSyncDeps,
): Promise<ConnectorSyncOutput> {
  const { connector: name, cursor } = ConnectorSyncInput.parse(input);
  const connector = await loadConnector(name, connectorConfigSlice(deps.config, name));
  const outcome = await syncConnector(deps.store, connector, {
    ...(cursor !== undefined ? { cursor } : {}),
    ...(deps.secrets ? { secrets: deps.secrets } : {}),
  });
  return ConnectorSyncOutput.parse(outcome);
}

/**
 * Self-contained MCP tool descriptor for the server (#8) to register.
 * `destructive: true` marks it as a write tool requiring HITL (ADR-0004).
 */
export const connectorSyncTool = {
  name: CONNECTOR_SYNC_TOOL_NAME,
  description:
    "Run a read-only connector ingest pass into the local store (write tool; " +
    "requires human approval — no auto-apply).",
  destructive: true as const,
  inputSchema: ConnectorSyncInput,
  outputSchema: ConnectorSyncOutput,
  run: runConnectorSyncTool,
};
