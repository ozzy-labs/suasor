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
  local: async () => {
    const { createLocalConnector } = await import("./local.ts");
    return (config: ConnectorConfig) => createLocalConnector(config);
  },
};

/**
 * The secret name(s) each connector resolves via `ctx.secret(...)` (see the
 * `secrets — ...` note atop each connector module). Used by introspection
 * (`connectors list`) to report whether a credential is configured **without**
 * disclosing its value. Web needs no auth (public pages only), so it has none.
 *
 * Kept here next to the registry so adding a connector declares its secret in
 * one place. Slack's flat/default workspace uses `"token"`; named workspaces use
 * `"<alias>:token"` (ADR-0014) — only the default token is introspected here.
 * Web and local read the filesystem / public pages only, so they need no auth.
 */
const SECRET_NAMES: Record<string, readonly string[]> = {
  github: ["token"],
  slack: ["token"],
  "ms-graph": ["clientSecret"],
  google: ["refreshToken"],
  box: ["token"],
  web: [],
  local: [],
};

/**
 * Connectors whose code path is fully bundled into the standalone single binary
 * (ADR-0010, docs/guide/install.md#binary-scope). The heavier connector SDKs are
 * kept **external** from the `bun build --compile` output to keep it light, so
 * those connectors can't `sync` in the binary — only the ones here can. Mirrors
 * the `--external` SDK list in package.json's `compile` script; the inverse set
 * (slack / ms-graph / google / box / web) gates with a binary-unsupported error.
 *
 * `github` uses `octokit` (bundled) and `local` reads the filesystem only, so
 * both work in the binary.
 */
const BINARY_BUNDLED_CONNECTORS: ReadonlySet<string> = new Set(["github", "local"]);

/** Names of all registered connectors (cheap; loads no SDK). */
export function connectorNames(): string[] {
  return Object.keys(REGISTRY).sort();
}

/**
 * Whether a connector's SDK is bundled into the standalone single binary (so its
 * `sync` works there). `false` for the connectors kept external to keep the
 * binary light (slack / ms-graph / google / box / web) and for unknown names.
 */
export function connectorBundledInBinary(name: string): boolean {
  return BINARY_BUNDLED_CONNECTORS.has(name);
}

/**
 * Secret names a connector reads via `ctx.secret(...)` (empty when it needs no
 * auth, e.g. `web`). Used by `connectors list` to report credential presence
 * without reading values. Unknown connectors return `[]`.
 */
export function connectorSecretNames(name: string): readonly string[] {
  return SECRET_NAMES[name] ?? [];
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
