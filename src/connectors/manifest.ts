/**
 * Per-connector manifest — the single SSOT for the platform knowledge that used
 * to be scattered across ~8 hand-maintained, name-keyed tables in different files
 * (registry `SECRET_NAMES` / `BINARY_BUNDLED_CONNECTORS`, `noop-check` `DETECTORS`,
 * onboard `CONNECTOR_SLICE_TEMPLATES`, `AUTH_SPECS`, `DISCOVERY_SPECS`,
 * `CHANNEL_META_KEYS` / `TEAM_META_KEYS`). Nothing structurally enforced that a
 * connector appeared in every table it needed, so forgetting one shipped silent
 * per-surface gaps that no compiler error or test caught (Issue #298 shipped
 * exactly this class of bug: missing `DETECTORS` entries, a wrong onboard-template
 * key). Issue #440 collapses that knowledge into one manifest **per connector**,
 * aggregated here, and a parametrized completeness test (see
 * `tests/connectors/manifest.test.ts`) asserts every registered connector's
 * manifest agrees with every real surface — or explicitly opts out with a reason
 * (`capabilityNotes`).
 *
 * Ownership split (deliberate, to preserve the lazy-import discipline, NFR-PRF-1):
 *  - **Owned** by the manifest (the data physically lives on it, and the old
 *    table module delegates here): `secretNames`, `bundledInBinary`,
 *    `sliceTemplate`, `noopWarning` (scope-emptiness), plus the config schema.
 *  - **Declared** by the manifest and cross-checked by the completeness test
 *    (the behaviour stays in its logic / hot-path module): `genericAuth`
 *    (`AUTH_SPECS`), `genericDiscovery` (`DISCOVERY_SPECS`), `surfacesChannels` /
 *    `surfacesTeams` (`channel.ts` / `team.ts`). The **credential precondition**
 *    is declared on each `Connector` instance (`Connector.credentials`) so the
 *    sync service enforces it centrally without importing this module in the hot
 *    loop; the manifest's `needsAuth` cross-checks it.
 *
 * Import-clean: this module eagerly imports each connector module's `manifest`
 * export, but a connector module is import-clean at the top level (`zod` +
 * contract types only) — the heavy SDK stays behind the lazy `import` inside
 * `sync` — so aggregating manifests pulls no connector SDK. Mirrors the existing
 * eager schema import in `noop-check.ts`. This module is imported only by
 * CLI-path / lazily-loaded consumers (`noop-check.ts`, onboard's `config-append`,
 * the completeness test), never by the registry / config / MCP-serve hot path, so
 * the eager parse cost stays off startup.
 */
import type { z } from "zod";
import { manifest as boxManifest } from "./box.ts";
import type { ConnectorConfig } from "./contract.ts";
import { manifest as githubManifest } from "./github.ts";
import { manifest as googleManifest } from "./google.ts";
import { manifest as jiraManifest } from "./jira.ts";
import { manifest as localManifest } from "./local.ts";
import { manifest as msGraphManifest } from "./ms-graph.ts";
import { manifest as notionManifest } from "./notion.ts";
import { manifest as slackManifest } from "./slack.ts";
import { manifest as webManifest } from "./web.ts";

/**
 * A minimal `[connectors.<name>]` slice template: the section body appended after
 * the `[connectors.<name>]` header by `suasor onboard` (ADR-0029 §3). Moved here
 * from `src/cli/onboard/config-append.ts` so the template lives with the rest of
 * the connector's manifest (and connectors never depend on the `cli` layer).
 */
export interface ConnectorSliceTemplate {
  /**
   * Body lines for the slice (without the `[connectors.<name>]` header). Always
   * includes `enabled = true`; connector-specific required keys are emitted as
   * commented placeholders the user fills in (a wrong default would silently
   * mis-sync — ADR-0029 trade-offs).
   */
  readonly body: readonly string[];
}

/** A connector's `[connectors.<name>]` config-slice schema (validated at load). */
export type ConnectorConfigSchema = z.ZodType<Record<string, unknown>, ConnectorConfig>;

/**
 * One non-secret config key a connector cannot work without (ADR-0049, Issue
 * #478).
 *
 * These keys are schema-*present* but empty-*tolerated*: `clientId` / `tenantId`
 * / `host` all carry a `.default("")` so an absent key parses cleanly, which is
 * what lets `[connectors.google] enabled = true` with no `clientId` sail past
 * `loadConfig`, `validate-config` and `doctor` and then fail only at sync time
 * with the vendor's own opaque error. The scope-emptiness detector
 * ({@link ConnectorManifest.noopWarning}) does not catch them either: the scope
 * can be perfectly well populated while the connector has nothing to
 * authenticate *with*.
 *
 * Declaring them here gives `doctor` the same "this config cannot work" verdict
 * Slack already had via its own config check, without a per-connector special
 * case in the CLI.
 */
export interface RequiredSetting {
  /** Config key inside `[connectors.<name>]` (e.g. `clientId`). */
  readonly key: string;
  /** What it is / where the operator gets it, appended to the doctor detail. */
  readonly hint: string;
}

/**
 * Everything the platform needs to know about one connector, in one place. Read
 * by the registry-adjacent lookups + the completeness test. See the module header
 * for the owned-vs-declared split.
 */
export interface ConnectorManifest {
  /** Stable connector name (CLI verb / config key), e.g. `github`. */
  readonly name: string;
  /** Projection `source_type` family this connector produces (e.g. `ms365`). */
  readonly sourceType: string;
  /** The `[connectors.<name>]` config-slice schema (drives `loadConfig`). */
  readonly configSchema: ConnectorConfigSchema;
  /**
   * Secret name(s) `connectors list` introspects for credential presence, without
   * disclosing values. Empty for the credential-free connectors (`web` / `local`).
   * This is the *introspection* view — Slack reports only its default-workspace
   * `token` here (per-alias secrets are dynamic, ADR-0014).
   */
  readonly secretNames: readonly string[];
  /**
   * Whether the connector requires a credential to sync. `true` ⟺ the connector
   * declares `Connector.credentials` ⟺ `secretNames` is non-empty. Cross-checked
   * by the completeness test so the three can never drift apart.
   */
  readonly needsAuth: boolean;
  /**
   * Whether the connector's code path is fully bundled into the standalone single
   * binary (ADR-0010). `false` for connectors whose heavy SDK is kept external.
   */
  readonly bundledInBinary: boolean;
  /** Onboard config-slice template (ADR-0029 §3). */
  readonly sliceTemplate: ConnectorSliceTemplate;
  /**
   * Scope-emptiness predicate (Issue #187, ADR-0007). Parses the raw config slice
   * with the connector's own schema and returns a human-readable "enabled but no
   * ingest target" warning, or `null` when a target exists. `null` (the field
   * itself) means the connector has no no-op notion (it ingests a fixed stream).
   */
  readonly noopWarning: ((slice: ConnectorConfig) => string | null) | null;
  /**
   * Non-secret config keys that must be non-empty for this connector to work at
   * all (ADR-0049). Omitted / empty when the connector has none (its schema
   * either requires nothing beyond a credential, or every key has a working
   * default). See {@link RequiredSetting} for why an empty-tolerated schema
   * default is not enough.
   */
  readonly requiredSettings?: readonly RequiredSetting[];
  /**
   * Whether the connector exposes the **generic** `<connector> auth set/test`
   * verbs (`AUTH_SPECS`, Issue #85). `false` when it needs no auth (`web` /
   * `local`) or maintains its own auth flow (`slack auth set/test`, ADR-0011) —
   * the latter documented in {@link capabilityNotes}.
   */
  readonly genericAuth: boolean;
  /**
   * Whether the connector exposes a **generic** `<connector> <verb>` discovery
   * verb (`DISCOVERY_SPECS`, ADR-0030). `false` when it has no id-discovery seam
   * (`web` / `local` / `ms-graph`) or its own richer flow (`slack conversations`).
   */
  readonly genericDiscovery: boolean;
  /**
   * Whether the connector emits `SlackChannelObserved` via `CHANNEL_META_KEYS`
   * (ADR-0037 §3). Only Slack surfaces channels today.
   */
  readonly surfacesChannels: boolean;
  /**
   * Whether the connector emits `SlackTeamObserved` via `TEAM_META_KEYS`
   * (ADR-0037 §10). Only Slack surfaces teams today.
   */
  readonly surfacesTeams: boolean;
  /**
   * Whether the connector has a **connector-specific onboarding bridge** in the
   * wizard (#458): `suasor onboard` drives its token store + probe + config
   * slice through a dedicated bridge instead of the generic AUTH_SPECS path.
   * Declared here, behaviour lives in the CLI registry
   * (`src/cli/onboard/bridges.ts` — connectors never depend on the cli layer);
   * the completeness test cross-checks the two. Default `false`.
   */
  readonly connectorSpecificOnboard?: boolean;
  /**
   * Human-readable reasons a connector opts out of a generic surface it might be
   * expected to have (keyed by surface: `genericAuth` / `genericDiscovery`). Used
   * by the completeness test to accept a documented opt-out, and as living docs
   * for why the flagship connector diverges from the platform abstractions.
   */
  readonly capabilityNotes?: Readonly<Record<string, string>>;
}

/** Registered connector manifests, by name. */
const MANIFESTS: Record<string, ConnectorManifest> = {
  box: boxManifest,
  github: githubManifest,
  google: googleManifest,
  jira: jiraManifest,
  local: localManifest,
  "ms-graph": msGraphManifest,
  notion: notionManifest,
  slack: slackManifest,
  web: webManifest,
};

/** The manifest for a connector, or `null` when the name is unregistered. */
export function connectorManifest(name: string): ConnectorManifest | null {
  return MANIFESTS[name] ?? null;
}

/** All registered manifests, sorted by connector name. */
export function allConnectorManifests(): ConnectorManifest[] {
  return Object.keys(MANIFESTS)
    .sort()
    .map((name) => MANIFESTS[name] as ConnectorManifest);
}

/** Connector names that have a manifest (sorted). Should equal `connectorNames()`. */
export function manifestConnectorNames(): string[] {
  return Object.keys(MANIFESTS).sort();
}
