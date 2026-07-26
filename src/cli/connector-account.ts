/**
 * `--account` resolution shared by the connector CLI verbs (ADR-0050, Issue
 * #441).
 *
 * A multi-account connector (`[connectors.<name>.accounts.<account>]`) makes
 * every credential-facing verb ambiguous: `auth set` writes *one* secret,
 * `auth test` and the discovery verbs read *one* account's settings. Resolving
 * that ambiguity by silently picking the first account is the failure this whole
 * ADR exists to prevent — a work token stored under the personal account's name
 * is invisible until the wrong mailbox syncs.
 *
 * Import-clean and lazy: the manifest / config loader are imported inside the
 * function, so registering CLI commands never pulls them (NFR-PRF-1).
 */
import type { AccountSlice } from "../connectors/multi-account.ts";

/**
 * The refusal for `--account` on a connector that declares no per-account
 * configuration, shared by every verb that can be handed one (Issue #544).
 *
 * Shared because the same question deserves the same answer: `onboard` already
 * named the connectors that *do* accept `--account`, while `auth` / the discovery
 * verbs only explained the capability, so the same mistake got a more useful
 * answer on one path than on another.
 *
 * `supported` is passed in rather than read here (this module stays import-clean,
 * NFR-PRF-1) — but every caller passes `multiAccountConnectorNames()`, derived
 * from the manifests. No call site lists connector names, so the connector that
 * adopts `multiAccount` next joins this message by flipping its own flag.
 */
export function noPerAccountConfigMessage(
  unsupported: readonly string[],
  supported: readonly string[],
): string {
  const declares = unsupported.length === 1 ? "it declares" : "they declare";
  // Defensive rather than decorative: with no multi-account connector at all the
  // parenthetical would be an empty `()`, which reads as a bug in the message.
  const accepted = supported.length === 0 ? "" : ` (${supported.join(", ")})`;
  return (
    `--account does not apply to ${unsupported.join(", ")}: ${declares} no per-account ` +
    `configuration — only a connector with a [connectors.<name>.accounts.<account>] ` +
    `table accepts it${accepted}`
  );
}

/** Resolved accounts, or a ready-to-print refusal (the CLI writes it verbatim). */
export type AccountResolution =
  | { readonly ok: true; readonly accounts: AccountSlice[] }
  | { readonly ok: false; readonly message: string };

export interface ResolveAccountsOptions {
  /**
   * Whether a config that fails to load is tolerated. `true` for `auth set`
   * (storing a credential before the config exists is a legitimate first-run
   * order, and the command separately notes a missing slice); `false` for the
   * verbs that *read* settings out of that config, where proceeding with an
   * empty slice would report a config problem as a credential problem.
   */
  readonly tolerateConfigError: boolean;
}

/**
 * Resolve the `--account` flag against the connector's declared capability and
 * its configured accounts.
 *
 * Refusals (each one a thing that would otherwise surface only as a credential
 * nothing ever reads):
 * - the connector declares no per-account configuration (`multiAccount: false`);
 * - the named account is not one the config declares (a typo);
 * - the config could not be loaded and the caller cannot tolerate that.
 *
 * With `account` omitted, **every** configured account is returned — a connector
 * with no `accounts` table yields exactly one implicit `default`, so the
 * single-account callers are unchanged.
 */
export async function resolveConnectorAccounts(
  connector: string,
  account: string | undefined,
  options: ResolveAccountsOptions,
): Promise<AccountResolution> {
  const [{ connectorManifest, multiAccountConnectorNames }, { accountSlices }] = await Promise.all([
    import("../connectors/manifest.ts"),
    import("../connectors/multi-account.ts"),
  ]);
  if (account !== undefined && connectorManifest(connector)?.multiAccount !== true) {
    return {
      ok: false,
      message: `error: ${noPerAccountConfigMessage([connector], multiAccountConnectorNames())}\n`,
    };
  }
  let slice: Record<string, unknown> = {};
  try {
    const { loadConfig } = await import("../config/index.ts");
    slice = ((await loadConfig()).connectors[connector] ?? {}) as Record<string, unknown>;
  } catch (cause) {
    if (!options.tolerateConfigError) {
      return { ok: false, message: `error: ${cause instanceof Error ? cause.message : cause}\n` };
    }
  }
  const accounts = accountSlices(slice);
  if (account === undefined) return { ok: true, accounts };
  const match = accounts.find((candidate) => candidate.name === account);
  if (!match) {
    return {
      ok: false,
      message:
        `error: no account '${account}' in [connectors.${connector}.accounts] ` +
        `(configured: ${accounts.map((a) => a.name).join(", ")})\n`,
    };
  }
  return { ok: true, accounts: [match] };
}

/**
 * Refuse an ambiguous single-target verb: the caller can only act on one account
 * and the operator named none while several are configured.
 *
 * Returned as a message rather than resolved by picking one, because both wrong
 * choices (writing a credential under the wrong name, enumerating the wrong
 * account's namespace) are silent until much later.
 */
export function ambiguousAccountMessage(connector: string, accounts: readonly AccountSlice[]) {
  return (
    `error: ${connector} has several configured accounts ` +
    `(${accounts.map((a) => a.name).join(", ")}) — pass --account <name>\n`
  );
}
