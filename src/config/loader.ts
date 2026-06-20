/**
 * Config loader.
 *
 * Resolves configuration with precedence `init args > env > file > defaults`
 * (docs/design/config.md). Layers are deep-merged then validated by the Zod
 * schema, so invalid values fail fast as `ConfigError`.
 *
 * Layer sources:
 * - **defaults**: the schema's own `.default()`s (applied by `Config.parse`).
 * - **file**: `config.toml` in the config dir (parsed with Bun's TOML loader).
 * - **env**: `SUASOR_*` variables, nesting via `__` (e.g.
 *   `SUASOR_EMBEDDING__BACKEND=ollama`). CI / headless override path.
 * - **init args**: explicit overrides passed by `suasor init` / callers.
 *
 * `[storage].dbPath = null` is resolved to `<configDir>/suasor.db` here so the
 * default tracks `SUASOR_CONFIG_DIR`.
 */
import { join } from "node:path";
import { z } from "zod";
import { loadConnectorConfigSchema } from "../connectors/registry.ts";
import { ConfigError } from "./error.ts";
import { Config } from "./schema.ts";

/**
 * Control keys recognized on **every** `[connectors.<name>]` slice, independent
 * of the connector. `enabled = false` opts a configured connector out of bulk
 * sync / `doctor` / `connectors list` (see `selectEnabledConnectors`); it is a
 * universal gate rather than a connector-specific field, so each connector's own
 * `*ConnectorConfig` schema omits it. Strict slice validation merges this in so
 * `enabled` is accepted while genuine typos still fail (docs/design/config.md).
 */
const COMMON_CONNECTOR_KEYS = z.object({ enabled: z.boolean().optional() });

/** A partial, untyped config tree from one layer (file / env / args). */
type Layer = Record<string, unknown>;

export interface LoadConfigOptions {
  /** Highest-precedence overrides (e.g. from `suasor init` flags). */
  initArgs?: Layer;
  /** Environment map (defaults to `process.env`). Injectable for tests. */
  env?: Record<string, string | undefined>;
  /** Config dir override (defaults to `SUASOR_CONFIG_DIR` or `~/.config/suasor`). */
  configDir?: string;
  /**
   * Pre-parsed file layer. Injectable for tests to avoid disk I/O; when
   * omitted the loader reads `config.toml` from the resolved config dir.
   */
  fileLayer?: Layer;
}

/** Resolve the config directory: explicit > `SUASOR_CONFIG_DIR` > `~/.config/suasor`. */
export function resolveConfigDir(
  env: Record<string, string | undefined> = process.env,
  explicit?: string,
): string {
  if (explicit) return explicit;
  const fromEnv = env.SUASOR_CONFIG_DIR;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const home = env.HOME ?? env.USERPROFILE ?? ".";
  return join(home, ".config", "suasor");
}

/** Recursively merge `src` into `dst` (objects deep, scalars/arrays replace). */
function deepMerge(dst: Layer, src: Layer): Layer {
  for (const [key, value] of Object.entries(src)) {
    if (value === undefined) continue;
    const existing = dst[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      dst[key] = deepMerge({ ...existing }, value);
    } else {
      dst[key] = value;
    }
  }
  return dst;
}

function isPlainObject(value: unknown): value is Layer {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Coerce a string env value to boolean / number when unambiguous, else keep string. */
function coerceScalar(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw !== "" && !Number.isNaN(Number(raw)) && /^-?\d+(\.\d+)?$/.test(raw)) {
    return Number(raw);
  }
  return raw;
}

/**
 * Build a nested layer from `SUASOR_*` env vars. `SUASOR_EMBEDDING__BACKEND`
 * maps to `{ embedding: { backend: ... } }`. Key segments are lowercased; `__`
 * separates nesting levels. `SUASOR_CONFIG_DIR` is consumed by dir resolution,
 * not config, so it is skipped.
 */
export function envToLayer(env: Record<string, string | undefined>): Layer {
  const layer: Layer = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (!name.startsWith("SUASOR_")) continue;
    if (name === "SUASOR_CONFIG_DIR") continue;
    const path = name
      .slice("SUASOR_".length)
      .toLowerCase()
      .split("__")
      .filter((s) => s.length > 0);
    if (path.length === 0) continue;
    let cursor = layer;
    for (let i = 0; i < path.length - 1; i++) {
      const segment = path[i] as string;
      const next = cursor[segment];
      if (!isPlainObject(next)) cursor[segment] = {};
      cursor = cursor[segment] as Layer;
    }
    cursor[path[path.length - 1] as string] = coerceScalar(value);
  }
  return layer;
}

/** Read & parse `config.toml` from the config dir; missing file → empty layer. */
async function readFileLayer(configDir: string): Promise<Layer> {
  const path = join(configDir, "config.toml");
  const file = Bun.file(path);
  if (!(await file.exists())) return {};
  let text: string;
  try {
    text = await file.text();
  } catch (cause) {
    throw new ConfigError(`failed to read config file: ${path}`, [String(cause)]);
  }
  try {
    // `Bun.TOML.parse` reads fresh each call (no module cache), so config edits
    // are picked up on the next load rather than being pinned by import cache.
    const data = Bun.TOML.parse(text);
    return isPlainObject(data) ? (data as Layer) : {};
  } catch (cause) {
    throw new ConfigError(`failed to parse TOML config: ${path}`, [String(cause)]);
  }
}

/**
 * Validate each `[connectors.<name>]` slice against the connector's own
 * config-slice schema (ADR-0007 / docs/design/config.md). The root schema keeps
 * `connectors` an open record, so without this a typo'd key (`repo` for `repos`)
 * loads cleanly and only silently no-ops at sync time. Here each *known*
 * connector's slice is re-validated **strictly** — unknown keys are rejected, not
 * stripped — so typos and type mismatches fail fast as `ConfigError` at load.
 *
 * Lenient by omission: a connector that exposes no slice schema (or a config key
 * for an unregistered connector) is left untouched, preserving backward
 * compatibility and allowing staged schema adoption. Validation reads only the
 * slice; the schema-normalized value is not written back (the open-record value
 * already carries the user's keys, and connectors re-parse their own slice when
 * built — `createXConnector` → `XConnectorConfig.parse`).
 *
 * The universal `enabled` gate (`COMMON_CONNECTOR_KEYS`) is merged into each
 * connector's object schema before going strict, so `enabled = false` is accepted
 * on any slice while genuine typos still fail. Non-object schemas (none today)
 * are validated as-is.
 *
 * Issues from every offending connector are collected into a single
 * `ConfigError`, each path prefixed `connectors.<name>` so the message points at
 * the exact field.
 */
async function validateConnectorSlices(
  connectors: Record<string, Record<string, unknown>>,
): Promise<void> {
  const issues: string[] = [];
  for (const [name, slice] of Object.entries(connectors)) {
    const schema = await loadConnectorConfigSchema(name);
    if (!schema) continue; // unknown / schema-less connector stays lenient
    // Merge the universal `enabled` gate, then `.strict()` so unrecognized keys
    // (typos) are rejected rather than stripped. Connector-specific fields come
    // from the connector's own schema (mirroring what it reads at build time).
    const validator =
      schema instanceof z.ZodObject ? schema.extend(COMMON_CONNECTOR_KEYS.shape).strict() : schema;
    const result = validator.safeParse(slice);
    if (result.success) continue;
    for (const issue of result.error.issues) {
      const tail = issue.path.length > 0 ? `.${issue.path.join(".")}` : "";
      issues.push(`connectors.${name}${tail}: ${issue.message}`);
    }
  }
  if (issues.length > 0) {
    throw new ConfigError("invalid connector configuration", issues);
  }
}

/**
 * Load and validate the effective configuration.
 *
 * @throws {ConfigError} when any layer holds an invalid value (fail-fast).
 */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<Config> {
  const env = options.env ?? process.env;
  const configDir = resolveConfigDir(env, options.configDir);

  const fileLayer = options.fileLayer ?? (await readFileLayer(configDir));
  const envLayer = envToLayer(env);
  const argsLayer = options.initArgs ?? {};

  // Lowest → highest precedence: file < env < init args (defaults via schema).
  const merged: Layer = {};
  deepMerge(merged, fileLayer);
  deepMerge(merged, envLayer);
  deepMerge(merged, argsLayer);

  const result = Config.safeParse(merged);
  if (!result.success) {
    throw new ConfigError(
      "invalid configuration",
      result.error.issues.map((issue: z.core.$ZodIssue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
        return `${path}: ${issue.message}`;
      }),
    );
  }

  const config = result.data;
  // Re-validate each configured connector slice against its own schema so typos
  // / type errors in `[connectors.<name>]` fail fast (the root schema leaves
  // `connectors` an open record). Slices for schema-less connectors stay lenient.
  await validateConnectorSlices(config.connectors);
  if (config.storage.dbPath === null) {
    config.storage.dbPath = join(configDir, "suasor.db");
  }
  if (config.export.dir === null) {
    config.export.dir = join(configDir, "exports");
  }
  return config;
}
