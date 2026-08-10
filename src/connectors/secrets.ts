/**
 * Connector secret resolution: OS keychain with an env override (NFR-PRV-4,
 * docs/design/config.md).
 *
 * Tokens are never written to `config.toml`. Resolution precedence, highest
 * first:
 *  1. **env override** — `SUASOR_CONNECTOR_<NAME>_<SECRET>` (uppercased,
 *     non-alphanumeric → `_`). The headless / Docker path (docs/design/config.md).
 *  2. **OS keychain** — `@napi-rs/keyring`, service `suasor`, account
 *     `connector:<name>:<secret>`.
 *
 * `@napi-rs/keyring` is a native addon, so it is **lazy-imported** inside each
 * function — importing this module pulls no native binding (import-clean,
 * ADR-0007).
 */

/** Keychain service name under which all Suasor connector secrets are stored. */
export const KEYCHAIN_SERVICE = "suasor";

/** Keychain account key for a connector secret: `connector:<name>:<secret>`. */
export function keychainAccount(connector: string, secret: string): string {
  return `connector:${connector}:${secret}`;
}

/**
 * Env var name for a connector secret override.
 * `(github, token)` → `SUASOR_CONNECTOR_GITHUB_TOKEN`.
 */
export function secretEnvName(connector: string, secret: string): string {
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return `SUASOR_CONNECTOR_${norm(connector)}_${norm(secret)}`;
}

export interface SecretStoreOptions {
  /** Environment map (defaults to `process.env`). Injectable for tests. */
  env?: Record<string, string | undefined>;
  /**
   * Keychain backend. Injectable so tests run without touching the real OS
   * keychain. When omitted, a `@napi-rs/keyring`-backed store is lazy-loaded.
   */
  keychain?: KeychainBackend;
}

/** Minimal keychain surface used here (subset of `@napi-rs/keyring` `Entry`). */
export interface KeychainBackend {
  /** Read a secret; returns `null` when absent. */
  get(service: string, account: string): string | null;
  /** Write a secret. */
  set(service: string, account: string, value: string): void;
}

/** Lazy `@napi-rs/keyring`-backed keychain (native addon imported on first use). */
async function loadKeyringBackend(): Promise<KeychainBackend> {
  const { Entry } = await import("@napi-rs/keyring");
  return {
    get(service, account) {
      try {
        return new Entry(service, account).getPassword();
      } catch {
        // No entry for this account (or keychain unavailable) → treat as absent.
        return null;
      }
    },
    set(service, account, value) {
      new Entry(service, account).setPassword(value);
    },
  };
}

/**
 * Resolve a connector secret: env override first, then the OS keychain.
 * Returns `null` when configured by neither.
 */
export async function resolveSecret(
  connector: string,
  secret: string,
  options: SecretStoreOptions = {},
): Promise<string | null> {
  const env = options.env ?? process.env;
  const fromEnv = env[secretEnvName(connector, secret)];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;

  const keychain = options.keychain ?? (await loadKeyringBackend());
  const value = keychain.get(KEYCHAIN_SERVICE, keychainAccount(connector, secret));
  return value && value.length > 0 ? value : null;
}

/** Persist a connector secret to the OS keychain (used by setup tooling). */
export async function storeSecret(
  connector: string,
  secret: string,
  value: string,
  options: SecretStoreOptions = {},
): Promise<void> {
  const keychain = options.keychain ?? (await loadKeyringBackend());
  keychain.set(KEYCHAIN_SERVICE, keychainAccount(connector, secret), value);
}

/**
 * Human-readable error for a failed keychain *write* ({@link storeSecret}) at a
 * CLI surface (Issue #557). A headless host (Docker, CI, a server) has no
 * Secret Service, so the write throws a raw native error at the exact moment
 * the user has just pasted a token — the most trust-sensitive step of setup.
 * Callers catch and print this instead: the failure plus the env-override
 * escape hatch (docs/design/config.md).
 */
export function storeSecretErrorMessage(connector: string, secret: string, cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return (
    `error: could not store the ${connector} secret in the OS keychain: ${detail}\n` +
    "hint: no keychain on this host (Docker / headless)? set the env override instead: " +
    `${secretEnvName(connector, secret)}=<value>\n`
  );
}

/** Outcome of {@link probeKeychain}: usable, or unavailable with the native reason. */
export type KeychainProbe = { available: true } | { available: false; reason: string };

/**
 * Keychain account probed by {@link probeKeychain}. Namespaced away from
 * `connector:` / `embedding:` entries so the probe can never read a real secret.
 */
const PROBE_ACCOUNT = "diagnostic:availability-probe";

/**
 * Probe whether the OS keychain is usable at all, distinguishing "keychain
 * unavailable" from "credential not stored" (Issue #557). The resolve path
 * deliberately swallows native errors (an absent entry and a broken backend
 * both read as `null`), which makes `doctor` misdiagnose a headless host as
 * "missing credential" and recommend `auth set` — which then crashes. This
 * probe surfaces the difference: a "no matching entry" error means the backend
 * answered (available); any other error (no Secret Service, locked backend) or
 * a failed native-module import (the standalone binary keeps `@napi-rs/keyring`
 * external, ADR-0010) means unavailable.
 */
export async function probeKeychain(options: SecretStoreOptions = {}): Promise<KeychainProbe> {
  // Reading a never-written account answers "can the backend be reached"
  // without touching any real secret. An injected backend returns null for an
  // absent entry (or throws to simulate a broken host); the native Entry is
  // probed *raw* — not through loadKeyringBackend, whose `get` swallows every
  // error into `null` (that swallowing is the very ambiguity this probe exists
  // to resolve).
  try {
    if (options.keychain) {
      options.keychain.get(KEYCHAIN_SERVICE, PROBE_ACCOUNT);
      return { available: true };
    }
    const { Entry } = await import("@napi-rs/keyring");
    new Entry(KEYCHAIN_SERVICE, PROBE_ACCOUNT).getPassword();
    return { available: true };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    if (/no matching entry/i.test(reason)) return { available: true };
    return { available: false, reason };
  }
}

/**
 * Build a {@link import("./contract.ts").SyncContext}-compatible `secret`
 * resolver bound to a connector, reusing one keychain backend across calls.
 */
export function makeSecretResolver(
  connector: string,
  options: SecretStoreOptions = {},
): (name: string) => Promise<string | null> {
  return (name) => resolveSecret(connector, name, options);
}

/**
 * Keychain account for an embedding-backend API key: `embedding:<backend>:apiKey`.
 * Kept in a namespace separate from connector secrets (`connector:…`) so an
 * embedding key never collides with a same-named connector token.
 */
export function embeddingKeychainAccount(backend: string): string {
  return `embedding:${backend}:apiKey`;
}

/**
 * Env var name for an embedding-backend API-key override.
 * `openai` → `SUASOR_EMBEDDING_OPENAI_API_KEY`.
 */
export function embeddingApiKeyEnvName(backend: string): string {
  const norm = backend.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return `SUASOR_EMBEDDING_${norm}_API_KEY`;
}

/**
 * Resolve an external embedding backend's API key (OpenAI / Voyage). Same
 * precedence as connector secrets — env override first, then the OS keychain —
 * so a headless / Docker deploy can inject the key without a keychain. The key
 * is never read from `config.toml` (NFR-PRV-4): sending body text to a remote
 * embedding API is an egress (ADR-0003), gated behind an explicit, securely
 * stored key.
 *
 * Returns `null` when configured by neither (the caller degrades to no embedder,
 * i.e. recall falls back to FTS, and a readiness warning is surfaced).
 */
export async function resolveEmbeddingApiKey(
  backend: string,
  options: SecretStoreOptions = {},
): Promise<string | null> {
  const env = options.env ?? process.env;
  const fromEnv = env[embeddingApiKeyEnvName(backend)];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;

  const keychain = options.keychain ?? (await loadKeyringBackend());
  const value = keychain.get(KEYCHAIN_SERVICE, embeddingKeychainAccount(backend));
  return value && value.length > 0 ? value : null;
}

/** Persist an embedding-backend API key to the OS keychain (setup tooling). */
export async function storeEmbeddingApiKey(
  backend: string,
  value: string,
  options: SecretStoreOptions = {},
): Promise<void> {
  const keychain = options.keychain ?? (await loadKeyringBackend());
  keychain.set(KEYCHAIN_SERVICE, embeddingKeychainAccount(backend), value);
}
