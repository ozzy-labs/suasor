/**
 * Secret masking for `config show` (NFR-PRV-4, docs/design/config.md).
 *
 * Connector tokens are never written to `config.toml` (they live in the OS
 * keychain or an env override; `src/connectors/secrets.ts`), so a well-formed
 * config tree holds no secret values. This module is defense-in-depth: if a user
 * has — against the contract — pasted a token into a config slice, `config show`
 * must still never echo it. Any value whose key *looks* secret-bearing is
 * replaced with the masked sentinel before the effective config is printed.
 */

/** Sentinel printed in place of a masked secret value. */
export const MASKED = "***";

/**
 * Keys whose value is treated as a secret and masked. Matched case-insensitively
 * as a substring of the key, so e.g. `clientSecret` / `refreshToken` / `apiKey`
 * are all caught. Kept deliberately broad: a false positive only hides a value
 * the user can still read from their own `config.toml`, whereas a false negative
 * leaks a credential.
 */
const SECRET_KEY_PATTERNS: readonly RegExp[] = [
  /secret/i,
  /token/i,
  /password/i,
  /passwd/i,
  /\bkey$/i,
  /apikey/i,
  /credential/i,
];

/** Whether a config key should have its value masked. */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERNS.some((re) => re.test(key));
}

/**
 * Deep-clone `value`, replacing every secret-keyed value with {@link MASKED}.
 * Objects and arrays are walked recursively; the input is never mutated.
 */
export function maskSecrets<T>(value: T): T {
  return maskNode(value) as T;
}

function maskNode(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => maskNode(item));
  }
  if (node !== null && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
      out[key] = isSecretKey(key) ? MASKED : maskNode(val);
    }
    return out;
  }
  return node;
}
