/**
 * Connector registry (ADR-0007). Maps a connector name to a **lazy loader** for
 * its factory, so neither registering nor listing connectors imports any
 * connector SDK — the SDK is pulled only when a connector is actually built and
 * synced (import-clean, NFR-PRF-1).
 *
 * Adding a connector = one entry here pointing at a `() => import("./<name>.ts")`
 * loader. This module imports only the contract types at the top level.
 */
import type { ConnectorConfig, ConnectorFactory } from "./contract.ts";

/** Lazy loader returning a connector's factory (SDK imported inside the factory). */
type FactoryLoader = () => Promise<ConnectorFactory>;

/** Registered connectors, by name → lazy factory loader. */
const REGISTRY: Record<string, FactoryLoader> = {
  github: async () => {
    const { createGithubConnector } = await import("./github.ts");
    return (config: ConnectorConfig) => createGithubConnector(config);
  },
  slack: async () => {
    const { createSlackConnector } = await import("./slack.ts");
    return (config: ConnectorConfig) => createSlackConnector(config);
  },
  "ms-graph": async () => {
    const { createMsGraphConnector } = await import("./ms-graph.ts");
    return (config: ConnectorConfig) => createMsGraphConnector(config);
  },
  google: async () => {
    const { createGoogleConnector } = await import("./google.ts");
    return (config: ConnectorConfig) => createGoogleConnector(config);
  },
  box: async () => {
    const { createBoxConnector } = await import("./box.ts");
    return (config: ConnectorConfig) => createBoxConnector(config);
  },
  web: async () => {
    const { createWebConnector } = await import("./web.ts");
    return (config: ConnectorConfig) => createWebConnector(config);
  },
};

/** Names of all registered connectors (cheap; loads no SDK). */
export function connectorNames(): string[] {
  return Object.keys(REGISTRY).sort();
}

/** Whether a connector name is registered. */
export function hasConnector(name: string): boolean {
  return name in REGISTRY;
}

/**
 * Build a connector by name from its config slice. The connector's module (and
 * its SDK) is imported here for the first time.
 *
 * @throws {Error} when the connector name is not registered.
 */
export async function loadConnector(name: string, config: ConnectorConfig) {
  const loader = REGISTRY[name];
  if (!loader) {
    throw new Error(`unknown connector: ${name} (known: ${connectorNames().join(", ") || "none"})`);
  }
  const factory = await loader();
  return factory(config);
}
