/**
 * Connector registry (ADR-0007). Maps a connector name to a **lazy loader** for
 * its factory, so neither registering nor listing connectors imports any
 * connector SDK — the SDK is pulled only when a connector is actually built and
 * synced (import-clean, NFR-PRF-1).
 *
 * Adding a connector = one entry here pointing at a `() => import("./<name>.ts")`
 * loader. This module imports only the contract types at the top level.
 */
import type { z } from "zod";
import type { ConnectorConfig, ConnectorFactory } from "./contract.ts";

/** Lazy loader returning a connector's factory (SDK imported inside the factory). */
type FactoryLoader = () => Promise<ConnectorFactory>;

/**
 * A connector's `[connectors.<name>]` config slice schema. Validates the slice
 * at `loadConfig` time so typos (e.g. `repo` for `repos`) fail fast instead of
 * silently no-op'ing at sync time (ADR-0007 / docs/design/config.md). Typed as a
 * loose `ZodType` so the registry stays connector-agnostic.
 */
type ConfigSchema = z.ZodType<Record<string, unknown>, ConnectorConfig>;

/**
 * Lazy loader returning a connector's config-slice schema. Lazy (not a direct
 * `import`) so that loading a *schema* still loads only the one connector module
 * being validated — and never every connector — preserving import-clean
 * registration (NFR-PRF-1). Connector modules are themselves import-clean at the
 * top level (only `zod` + contract types), so importing one for its schema pulls
 * no heavy SDK; the SDK stays behind the lazy `import` inside `sync`.
 */
type SchemaLoader = () => Promise<ConfigSchema>;

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
  notion: async () => {
    const { createNotionConnector } = await import("./notion.ts");
    return (config: ConnectorConfig) => createNotionConnector(config);
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
 * Per-connector config-slice schemas, by name → lazy schema loader. Each entry
 * lazy-imports its connector module's exported `*ConnectorConfig` Zod schema so
 * that `loadConfig` can validate `[connectors.<name>]` against the connector's
 * own contract (ADR-0007). A connector that does not yet expose a slice schema
 * is simply absent here and stays lenient (the root schema keeps it as an open
 * record), so adoption can be staged without breaking existing configs.
 *
 * Adding a connector schema = one entry here pointing at its `*ConnectorConfig`.
 */
const CONFIG_SCHEMAS: Record<string, SchemaLoader> = {
  github: async () => (await import("./github.ts")).GithubConnectorConfig,
  slack: async () => (await import("./slack.ts")).SlackConnectorConfig,
  "ms-graph": async () => (await import("./ms-graph.ts")).MsGraphConnectorConfig,
  google: async () => (await import("./google.ts")).GoogleConnectorConfig,
  box: async () => (await import("./box.ts")).BoxConnectorConfig,
  notion: async () => (await import("./notion.ts")).NotionConnectorConfig,
  web: async () => (await import("./web.ts")).WebConnectorConfig,
  // Uses the load-time variant so each configured root is verified to exist and
  // be a readable directory at `loadConfig` time (Issue #188), not warn+skipped
  // mid-sync. The structural `LocalConnectorConfig` (no FS check) is what the
  // connector itself parses at build time.
  local: async () => (await import("./local.ts")).LocalConnectorConfigSchema,
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
  notion: ["token"],
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
 * both work in the binary. `notion` is `fetch`-based (no heavy SDK to externalize,
 * mirroring `web`), so it too works in the binary.
 */
const BINARY_BUNDLED_CONNECTORS: ReadonlySet<string> = new Set(["github", "local", "notion"]);

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

/** Whether a connector exposes a config-slice schema for `loadConfig` validation. */
export function hasConnectorConfigSchema(name: string): boolean {
  return name in CONFIG_SCHEMAS;
}

/**
 * Lazy-load a connector's `[connectors.<name>]` config-slice schema, or `null`
 * when the connector exposes none (it then stays lenient — an open record at the
 * root). Importing the schema pulls only the one connector module (import-clean;
 * no heavy SDK), so the config loader can validate a single configured slice
 * without registering every connector.
 */
export async function loadConnectorConfigSchema(name: string): Promise<ConfigSchema | null> {
  const loader = CONFIG_SCHEMAS[name];
  if (!loader) return null;
  return loader();
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
