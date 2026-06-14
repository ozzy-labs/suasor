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
import type { z } from "zod";
import { ConfigError } from "./error.ts";
import { Config } from "./schema.ts";

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
  if (config.storage.dbPath === null) {
    config.storage.dbPath = join(configDir, "suasor.db");
  }
  return config;
}
