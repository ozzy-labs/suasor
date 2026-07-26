/**
 * Pre-sync no-op config detection (Issue #187, ADR-0007).
 *
 * A connector slice can be *enabled* (a `[connectors.<name>]` section exists and
 * is not `enabled = false`) yet still ingest nothing because its scope is empty:
 * github with no `repos` and `notifications = "off"`, box with no `folders`,
 * local with no `roots`, web with no `urls`, google/ms-graph with empty
 * `resources`, notion with no `databases` and `pages = false`, jira with no
 * `projects` and no `jql`. Without a hint the sync just reports `0 observed` and
 * the user has to inspect the DB to realize their config never had a target (the
 * failure mode called out in the issue).
 *
 * `noopWarning` inspects a connector's config slice (validated against the
 * connector's own Zod schema for shape parity with `loadConfig`) and returns a
 * human-readable warning when the slice resolves to "enabled but no ingest
 * target", or `null` otherwise. It is a *warning only* — callers print it to
 * stderr before sync and do **not** change the exit code (the run still succeeds
 * with 0 observed; ADR-0027 exit-code semantics are unchanged).
 *
 * Every advisory here is evaluated **per account** (ADR-0050): a connector with
 * `[connectors.<name>.accounts.<x>]` tables is several ingest configurations
 * sharing one section, and a connector-level verdict would report "fine" as soon
 * as one account happened to be complete.
 *
 * The per-connector scope-emptiness predicate is no longer a table in this file:
 * it moved onto each connector's manifest (`ConnectorManifest.noopWarning`,
 * Issue #440), so a new connector declares it in one place and the completeness
 * test enforces it. This module is now a thin lookup over the manifest registry.
 *
 * Import-clean: this module imports only the manifest aggregation (which eager-
 * imports the per-connector manifests — plain data + Zod schemas, no heavy SDK,
 * mirroring the discipline the DETECTORS table used to rely on). The manifest
 * module is never on the registry / config / MCP-serve hot path.
 */

import type { ConnectorConfig } from "./contract.ts";
import { connectorManifest, type RequiredSetting } from "./manifest.ts";
import { type AccountSlice, accountSecretName, accountSlices } from "./multi-account.ts";

/**
 * One advisory, attributed to the account it is about (ADR-0050).
 *
 * `account` is `null` for a single-account config — the overwhelmingly common
 * case, and the one whose messages must stay exactly as they were. It carries the
 * account name only once the config declares an `accounts` table, so a caller
 * never has to invent a label for an account the operator never named.
 */
export interface ConnectorAdvisory {
  /** Declared account this advisory is about, or `null` when unnamed. */
  readonly account: string | null;
  /** Message body (callers prefix it with the connector name). */
  readonly message: string;
}

/** The advisory account label for a resolved account (`null` when unnamed). */
function advisoryAccount(account: AccountSlice): string | null {
  return account.declared ? account.name : null;
}

/**
 * Prefix a connector name with the account an advisory is about, for the
 * `warning: <name>: ...` / doctor `detail` formatting. Single-account configs
 * render exactly as before (`github`); a declared account adds one clause
 * (`google (account 'work')`).
 */
export function advisoryLabel(connector: string, account: string | null): string {
  return account === null ? connector : `${connector} (account '${account}')`;
}

/**
 * Return the no-op warnings for a connector's config slice — one per configured
 * account whose ingest scope is empty — or an empty array when every account has
 * a target (or the connector has no no-op notion). The message is the *body*
 * only; callers prefix it via {@link advisoryLabel}, matching the existing
 * `onWarn` formatting in the sync commands.
 *
 * Per account (ADR-0050) rather than per connector: with two Google accounts, one
 * of them having no `resources` is exactly the state this advisory exists to
 * surface, and a connector-level verdict would report "fine" because the other
 * one has a target.
 *
 * Best-effort: a slice that fails to parse (already rejected upstream by
 * `loadConfig`, #162) is skipped rather than throwing, so this never turns a
 * pre-sync advisory into a hard error.
 */
export function noopWarnings(name: string, slice: ConnectorConfig): ConnectorAdvisory[] {
  const detect = connectorManifest(name)?.noopWarning;
  if (!detect) return [];
  const advisories: ConnectorAdvisory[] = [];
  for (const account of accountSlices(slice)) {
    try {
      const message = detect(account.slice);
      if (message !== null) advisories.push({ account: advisoryAccount(account), message });
    } catch {
      // Unparseable slice — reported by loadConfig, not by this advisory.
    }
  }
  return advisories;
}

/**
 * Return a "required setting is empty" message for a connector's config slice,
 * or `null` when every declared {@link RequiredSetting} is populated (ADR-0049,
 * Issue #478).
 *
 * Distinct from {@link noopWarning}, and deliberately not folded into it: an
 * empty scope means the connector runs and ingests nothing (a warning — the run
 * still succeeds), whereas an empty required setting means the connector cannot
 * authenticate or address its API at all (the run fails, with the vendor's
 * error). They differ in both severity and remedy, so callers report them as
 * separate lines.
 *
 * The message is the *body* only — callers prefix it with the connector name,
 * matching the existing `warning: <name>: ...` formatting.
 */
export function missingSettingWarnings(name: string, slice: ConnectorConfig): ConnectorAdvisory[] {
  const required = connectorManifest(name)?.requiredSettings ?? [];
  if (required.length === 0) return [];
  const advisories: ConnectorAdvisory[] = [];
  for (const account of accountSlices(slice)) {
    const missing = required.filter((setting) => {
      const value = account.slice[setting.key];
      return typeof value !== "string" || value.trim().length === 0;
    });
    if (missing.length === 0) continue;
    const detail = missing.map((s) => `${s.key} (${s.hint})`).join(", ");
    // The section to fix is the account's own table once one is declared —
    // pointing at `[connectors.google]` when the empty key lives under
    // `accounts.work` would send the operator to the wrong place.
    const section = account.declared
      ? `[connectors.${name}.accounts.${account.name}]`
      : `[connectors.${name}]`;
    advisories.push({
      account: advisoryAccount(account),
      message:
        `required setting(s) not set: ${detail} — the connector cannot reach its API ` +
        `until they are set in ${section}`,
    });
  }
  return advisories;
}

/**
 * Secret names to probe for a connector's credential presence, one entry per
 * configured account (ADR-0050). For a single-account config this is exactly the
 * connector's declared manifest `secretNames` with a `null` account, i.e. the
 * pre-ADR-0050 introspection view.
 *
 * Connectors that do not declare `multiAccount` return their base names even when
 * the slice happens to carry an `accounts` key — the capability is what the
 * manifest declares, never what a stray config key implies.
 */
export function accountSecretProbes(name: string, slice: ConnectorConfig): AccountSecretProbe[] {
  const manifest = connectorManifest(name);
  if (!manifest) return [];
  const bases = manifest.secretNames;
  if (!manifest.multiAccount) {
    return bases.map((base) => ({ account: null, base, secret: base }));
  }
  const probes: AccountSecretProbe[] = [];
  for (const account of accountSlices(slice)) {
    for (const base of bases) {
      probes.push({
        account: advisoryAccount(account),
        base,
        secret: accountSecretName(account, base),
      });
    }
  }
  return probes;
}

/** One credential-presence probe: which account, and the secret name to resolve. */
export interface AccountSecretProbe {
  /** Declared account this credential belongs to, or `null` when unnamed. */
  readonly account: string | null;
  /** The connector's base secret name (e.g. `refreshToken`), for display. */
  readonly base: string;
  /** The name to pass to `resolveSecret` (`<account>:<base>` for a named account). */
  readonly secret: string;
}

/**
 * Config-path label for a credential probe, for the presence-only displays
 * (`config show`, `doctor`). Existence only, never a value (NFR-PRV-4).
 */
export function probeConfigPath(connector: string, probe: AccountSecretProbe): string {
  return probe.account === null
    ? `connectors.${connector}.${probe.base}`
    : `connectors.${connector}.accounts.${probe.account}.${probe.base}`;
}

/**
 * Report the flat `[connectors.<name>]` keys being demoted to inheritance
 * defaults once an `accounts` table exists without a `default` entry (ADR-0050).
 *
 * The failure this addresses is real: an operator who adds
 * `[connectors.google.accounts.work]` to a working flat config stops ingesting
 * the account they had. It is deliberately reported in **two confidence levels**,
 * because only one of them is a fact:
 *
 * - `credentialStored: true` — a credential for the unnamed default account is
 *   still in the keychain / env. That is evidence the account existed, so the
 *   message says the ingest stopped.
 * - `credentialStored: false` — nothing distinguishes "never had a default
 *   account" from "had one and removed the credential too". The message states
 *   the rule and does not assert anything about this install's history.
 *
 * Returns `null` when the situation does not apply (no `accounts` table, or one
 * that declares `default`).
 */
export function demotedDefaultAccountNotice(
  name: string,
  slice: ConnectorConfig,
  credentialStored: boolean,
): { severity: "warn" | "info"; message: string } | null {
  const accounts = accountSlices(slice);
  if (!accounts.some((account) => account.declared)) return null;
  if (accounts.some((account) => account.isDefault)) return null;
  const named = accounts.map((account) => `'${account.name}'`).join(", ");
  const rule =
    `the flat [connectors.${name}] keys are inherited defaults for ${named}, not an ` +
    `ingested account of their own`;
  const fix =
    `add [connectors.${name}.accounts.default] (it may be empty — it inherits the flat ` +
    `keys) to ingest it alongside the named accounts`;
  return credentialStored
    ? {
        severity: "warn",
        message: `a credential is stored for the unnamed default account, but ${rule}, so it is no longer synced — ${fix}`,
      }
    : { severity: "info", message: `${rule}. If that account should also be synced, ${fix}` };
}
