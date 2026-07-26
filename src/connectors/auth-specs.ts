/**
 * Per-connector auth spec SSOT for the generic `<connector> auth set` /
 * `<connector> auth test` CLI verbs (Issue #85; extends ADR-0011's Slack-only
 * operational verbs to github / ms-graph / google / box).
 *
 * Slack keeps its own `slack auth set/test` (multi-workspace + scope readiness,
 * ADR-0011/0014); this table covers the other token-bearing connectors. The verb
 * surface is data-driven from {@link AUTH_SPECS}: `auth set` stores the connector's
 * primary secret in the OS keychain (reusing `storeSecret`), and `auth test` runs
 * the connector's `test` probe (a `fetch`-only round-trip, no SDK — import-clean
 * per ADR-0007). Readiness is self-reported `READY / MISSING / N/A` per opshub's
 * `assessReadiness` shape.
 *
 * Import-clean: this module's top-level imports are limited to the per-connector
 * auth leaf modules' **types** only — the leaf modules themselves are pulled at
 * `auth test` time. (Each leaf is `fetch`-only, so even importing them eagerly
 * loads no SDK; keeping them lazy mirrors the rest of the CLI's discipline.)
 *
 * Per-feature readiness (Issue #194): each connector's `auth test` emits a
 * `features:` block in Slack's format ({@link import("./slack/scopes.ts")}),
 * generalizing Slack's feature→scope capability model. {@link featureReadiness}
 * assesses scope presence by **substring** (the OAuth surfaces here report scopes
 * as full URLs or coarse tokens, unlike Slack's exact-token set), and the
 * resource-gated connectors (ms-graph / google) emit one row per configured
 * `resources` entry. Verdicts are conservative self-reports (`READY` / `MISSING` /
 * `N/A`); a granted scope never implies a resource is actually reachable.
 *
 * Per-resource **reachability** (ADR-0049, Issue #478) is a second, separate
 * layer: for the resource-gated connectors, `auth test` additionally probes each
 * configured resource with one read-only GET and reports `reachable` /
 * `unreachable` / `unknown` ({@link import("./resource-probe.ts")}). It is kept
 * as its own block rather than folded into the `features:` verdicts precisely
 * because the two have different confidence — a scope row is a self-report about
 * what was granted, a reachability row is what the API answered — and collapsing
 * them would let one taint the other.
 */

import type { ResourceProbeTransport, ResourceReachability } from "./resource-probe.ts";

/** One self-reported readiness row for an `auth test` `features:` block. */
export interface AuthFeatureReadiness {
  /** Human display label. */
  readonly label: string;
  /** `READY` / `MISSING <detail>` / `N/A <detail>`. */
  readonly status: string;
}

/** Normalized outcome of a connector's `auth test` probe. */
export interface AuthTestReport {
  /** One-line identity summary (e.g. `octocat`, `team@contoso.com`). */
  readonly principal: string;
  /** Comma/space-separated granted scopes, or `null` when the API reports none. */
  readonly scopes: string | null;
  /** Per-feature readiness rows (scope layer; may be empty). */
  readonly features: readonly AuthFeatureReadiness[];
  /**
   * Per-resource reachability rows (ADR-0049). Present only for the connectors
   * that declare probe targets **and** only when the caller asked for the probe
   * (`probe: true`); absent means "not probed", which is deliberately distinct
   * from "probed and found nothing".
   */
  readonly resources?: readonly ResourceReachability[];
}

/** Resolves a connector secret by name (keychain + env override). */
export type SecretResolver = (name: string) => Promise<string | null>;

/** A connector's auth spec: secret to store + probe to verify it. */
export interface ConnectorAuthSpec {
  /** Connector name (CLI verb prefix), e.g. `github`. */
  readonly connector: string;
  /** Keychain secret name `auth set` stores (e.g. `token`, `clientSecret`). */
  readonly secretName: string;
  /** Human label for the secret in `auth set` output (e.g. `PAT`, `client secret`). */
  readonly secretLabel: string;
  /**
   * Run the verification probe. Resolves secrets + reads config as needed via the
   * injected `secret` resolver and `config` slice, calls the connector's
   * `fetch`-only test function, and normalizes the result. Throws on a failed
   * probe (the CLI surfaces the message; secrets are never echoed).
   */
  readonly test: (deps: {
    secret: SecretResolver;
    config: Record<string, unknown>;
    /**
     * Run the per-resource reachability probe (ADR-0049) after the credential
     * round-trip. Costs one extra read-only GET per **configured** resource, so
     * it is a caller decision (`auth test` defaults it on, `--no-probe` opts
     * out). Connectors with no probe targets ignore it.
     */
    probe?: boolean;
    /** Injectable probe transport (tests drive it without network). */
    probeTransport?: ResourceProbeTransport;
  }) => Promise<AuthTestReport>;
  /**
   * Whether this connector has per-resource reachability probes at all. Drives
   * the CLI's `--no-probe` help and lets the completeness test tell "no probe
   * targets" apart from "forgot to wire the probe".
   */
  readonly probesResources?: boolean;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * One feature's scope precondition for a non-Slack connector. Mirrors Slack's
 * {@link import("./slack/scopes.ts").FeatureScopeSpec} shape but assesses scope
 * presence by **substring** match: the OAuth surfaces here report scopes as full
 * URLs (Google: `https://www.googleapis.com/auth/drive.readonly`) or
 * coarse-grained tokens (GitHub classic: `repo`), so a feature is satisfied when
 * ANY of its `scopeNeedles` is found as a substring of the granted scope string.
 * (Slack's exact-token model does not fit these heterogeneous formats.)
 */
export interface FeatureSpec {
  /** Human display label shown in the `auth test` `features:` block. */
  readonly label: string;
  /**
   * Scope substrings that satisfy the feature; the feature is READY when the
   * granted scope string contains ANY of them. Empty → never scope-gated
   * (presence of any scope, or a config gate, drives the verdict).
   */
  readonly scopeNeedles: readonly string[];
}

/**
 * Assess one feature's readiness from a connector's granted scope string.
 *
 * Pure, no I/O: a scope-layer capability model only (ADR-0011, generalized from
 * Slack to the other token-bearing connectors). The verdict is self-reported and
 * deliberately conservative — it asserts only "the needed scope appears granted",
 * never that a specific resource is reachable.
 *
 * - `scopes === null` (API reported none, e.g. Box, or ms-graph's `.default`
 *   which resolves app permissions server-side) → `N/A (scopes not enumerated)`;
 *   the live probe already proved the credential valid.
 * - empty granted set → `MISSING <needles>`.
 * - any needle present → `READY`; otherwise `MISSING <needles>`.
 */
export function featureReadiness(spec: FeatureSpec, scopes: string | null): AuthFeatureReadiness {
  if (spec.scopeNeedles.length === 0) {
    return { label: spec.label, status: "READY" };
  }
  if (scopes === null) {
    return { label: spec.label, status: "N/A (scopes not enumerated)" };
  }
  const granted = scopes.toLowerCase();
  const ready = spec.scopeNeedles.some((needle) => granted.includes(needle.toLowerCase()));
  return {
    label: spec.label,
    status: ready ? "READY" : `MISSING ${spec.scopeNeedles.join(" | ")}`,
  };
}

/** Read a connector config slice's `resources` list (e.g. `["mail","calendar"]`). */
export function configuredResources(config: Record<string, unknown>): Set<string> {
  const raw = config.resources;
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((r): r is string => typeof r === "string"));
}

/**
 * Read a google config slice's `calendarIds` list (ADR-0051). Absent ⇒ the
 * schema default (`["primary"]`), because that is what `sync` will read; an
 * explicit `[]` stays empty, because that is a deliberate "no calendars" and
 * substituting `primary` there would probe something nothing ingests.
 */
export function configuredCalendarIds(config: Record<string, unknown>): string[] {
  const raw = config.calendarIds;
  if (raw === undefined) return ["primary"];
  if (!Array.isArray(raw)) return [];
  return raw.filter((id): id is string => typeof id === "string" && id.length > 0);
}

/**
 * ms-graph resource → its `features:` row label + the Azure application
 * permission an operator must grant. Client-credentials reports `.default`
 * (resolved server-side), so the row is N/A rather than scope-asserted — the
 * label names the permission to confirm in the app registration.
 */
const MS_GRAPH_RESOURCE_FEATURES: Record<string, FeatureSpec> = {
  mail: { label: "mail read (Mail.Read)", scopeNeedles: ["mail.read"] },
  calendar: { label: "calendar read (Calendars.Read)", scopeNeedles: ["calendars.read"] },
  files: { label: "files read (Files.Read.All)", scopeNeedles: ["files.read"] },
  teams: { label: "teams read (Channel/Chat.Read.All)", scopeNeedles: ["channelmessage.read"] },
};

/** google resource → its `features:` row label + the OAuth scope substring. */
const GOOGLE_RESOURCE_FEATURES: Record<string, FeatureSpec> = {
  drive: { label: "Drive read", scopeNeedles: ["drive"] },
  gmail: { label: "Gmail read", scopeNeedles: ["gmail", "mail.google.com"] },
  calendar: { label: "Calendar read", scopeNeedles: ["calendar"] },
};

/**
 * Build the github `features:` rows from granted scopes + config. `issue / pull
 * request read` is always shown; `notifications stream` only when the connector
 * is configured to ingest it (`notifications != "off"`). Fine-grained PATs report
 * no scope header (`scopes === null`) → the rows are N/A (the GET /user probe
 * already proved validity); classic PATs carry `repo` / `notifications` tokens.
 */
export function githubFeatures(
  scopes: string | null,
  notifications: string,
): AuthFeatureReadiness[] {
  const features: AuthFeatureReadiness[] = [
    featureReadiness({ label: "issue / pull request read", scopeNeedles: ["repo"] }, scopes),
  ];
  if (notifications && notifications !== "off") {
    features.push(
      featureReadiness(
        { label: "notifications stream", scopeNeedles: ["notifications", "repo"] },
        scopes,
      ),
    );
  }
  return features;
}

/**
 * Build the ms-graph `features:` rows from the configured `resources`. The
 * client-credentials token only ever reports `.default` (app permissions are
 * resolved server-side and not enumerated in the token), so each configured
 * resource is reported N/A — we pass `null` scopes regardless of the `.default`
 * string so {@link featureReadiness} never emits a false MISSING for a permission
 * it structurally cannot see. When no resources are configured, the connector
 * ingests nothing — surface that as one explanatory row rather than an empty
 * block.
 */
export function msGraphFeatures(resources: Set<string>): AuthFeatureReadiness[] {
  return resourceFeatures(MS_GRAPH_RESOURCE_FEATURES, resources, null);
}

/** Build the google `features:` rows from the configured `resources` + scopes. */
export function googleFeatures(
  resources: Set<string>,
  scopes: string | null,
): AuthFeatureReadiness[] {
  return resourceFeatures(GOOGLE_RESOURCE_FEATURES, resources, scopes);
}

/**
 * Shared resource-gated readiness builder for the `resources = [...]` connectors
 * (ms-graph / google). Emits one row per configured resource in the map's
 * declaration order; unknown resource names are ignored (forward-compatible with
 * config that names a resource this readiness model doesn't map yet). An empty /
 * absent `resources` yields a single "no resources configured" row.
 */
function resourceFeatures(
  map: Record<string, FeatureSpec>,
  resources: Set<string>,
  scopes: string | null,
): AuthFeatureReadiness[] {
  if (resources.size === 0) {
    return [{ label: "ingestion", status: "N/A (no resources configured)" }];
  }
  const rows: AuthFeatureReadiness[] = [];
  for (const [resource, spec] of Object.entries(map)) {
    if (resources.has(resource)) rows.push(featureReadiness(spec, scopes));
  }
  return rows;
}

/** Connector → auth spec (the SSOT for the generic verbs). */
export const AUTH_SPECS: Record<string, ConnectorAuthSpec> = {
  github: {
    connector: "github",
    secretName: "token",
    secretLabel: "Personal Access Token",
    async test({ secret, config }) {
      const token = await secret("token");
      if (!token) throw new Error("no github token configured");
      const { testGithubAuth } = await import("./github/auth.ts");
      const baseUrl = asString(config.baseUrl) || undefined;
      const result = await testGithubAuth(token, undefined, baseUrl);
      const scopes = result.scopes.length > 0 ? result.scopes : null;
      const features = githubFeatures(scopes, asString(config.notifications));
      return { principal: result.login || "(unknown login)", scopes, features };
    },
  },
  "ms-graph": {
    connector: "ms-graph",
    secretName: "clientSecret",
    secretLabel: "app client secret",
    probesResources: true,
    async test({ secret, config, probe, probeTransport }) {
      const clientSecret = await secret("clientSecret");
      if (!clientSecret) throw new Error("no ms-graph clientSecret configured");
      const tenantId = asString(config.tenantId);
      const clientId = asString(config.clientId);
      if (!tenantId || !clientId) {
        throw new Error("ms-graph: tenantId and clientId are required in config");
      }
      const { testMsGraphAuth } = await import("./ms-graph/auth.ts");
      const result = await testMsGraphAuth({ tenantId, clientId, clientSecret });
      const scopes = result.scope.length > 0 ? result.scope : null;
      // Client-credentials returns `.default`, which resolves the app's
      // *application permissions* server-side — the token's `scope` field does
      // not enumerate them. Per-resource scope verification is therefore not
      // possible here; readiness reflects which Graph resources are *configured*
      // (`resources = [...]`) and reports them N/A (scopes not enumerated). The
      // operator confirms the actual Mail.Read / Calendars.Read / Files.Read.All
      // / Channel/Chat permissions in the Azure app registration — or, better,
      // lets the reachability probe below answer it from the API (ADR-0049).
      const resources = configuredResources(config);
      const features = msGraphFeatures(resources);
      const principal = `app ${clientId} @ tenant ${tenantId}`;
      if (!probe) return { principal, scopes, features };
      const [{ msGraphProbeSpecs }, { probeResources, unprobedResources }] = await Promise.all([
        import("./ms-graph/probe.ts"),
        import("./resource-probe.ts"),
      ]);
      // No `|| "me"` fallback (ADR-0051): this credential is app-only, where
      // `/users/me` is read as a literal id and 404s. Probing it would report a
      // failure about a user the operator never configured, hiding the real
      // finding — that the mailbox to read has not been named.
      const user = asString(config.user);
      if (user.length === 0) {
        return {
          principal,
          scopes,
          features,
          resources: unprobedResources(
            [...resources],
            "`user` is not set — app-only (client-credentials) credentials have no signed-in " +
              "user, so the mailbox / drive to read must be named by UPN or object id in " +
              "[connectors.ms-graph]",
          ),
        };
      }
      const specs = msGraphProbeSpecs(resources, user);
      return {
        principal,
        scopes,
        features,
        resources: await probeResources(specs, result.accessToken, probeTransport),
      };
    },
  },
  google: {
    connector: "google",
    secretName: "refreshToken",
    secretLabel: "OAuth refresh token",
    probesResources: true,
    async test({ secret, config, probe, probeTransport }) {
      const refreshToken = await secret("refreshToken");
      if (!refreshToken) throw new Error("no google refreshToken configured");
      const clientId = asString(config.clientId);
      if (!clientId) throw new Error("google: clientId is required in config");
      const clientSecret = (await secret("clientSecret")) ?? undefined;
      const { testGoogleAuth } = await import("./google/auth.ts");
      const result = await testGoogleAuth({
        clientId,
        refreshToken,
        ...(clientSecret ? { clientSecret } : {}),
      });
      const scopes = result.scope.length > 0 ? result.scope : null;
      const resources = configuredResources(config);
      const features = googleFeatures(resources, scopes);
      const principal = `client ${clientId}`;
      if (!probe) return { principal, scopes, features };
      const [{ googleProbeSpecs }, { probeResources, unprobedResources }] = await Promise.all([
        import("./google/probe.ts"),
        import("./resource-probe.ts"),
      ]);
      // `calendarIds` are the calendars sync reads — probing each of them is what
      // turns a mistyped id from a silent empty ingest into a 404 (ADR-0007).
      const calendarIds = configuredCalendarIds(config);
      const specs = googleProbeSpecs(resources, calendarIds);
      const rows = await probeResources(specs, result.accessToken, probeTransport);
      // `calendar` configured with an empty id list probes nothing; say so
      // rather than dropping the row, which would read as "no calendar
      // configured" (ADR-0051).
      const unprobed =
        resources.has("calendar") && calendarIds.length === 0
          ? unprobedResources(
              ["calendar"],
              "calendarIds is empty — list the calendar ids to ingest " +
                "(`suasor google calendars` enumerates the visible ones)",
            )
          : [];
      return { principal, scopes, features, resources: [...rows, ...unprobed] };
    },
  },
  box: {
    connector: "box",
    secretName: "token",
    secretLabel: "access token",
    async test({ secret }) {
      const token = await secret("token");
      if (!token) throw new Error("no box token configured");
      const { testBoxAuth } = await import("./box/auth.ts");
      const result = await testBoxAuth(token);
      const who =
        result.name && result.login
          ? `${result.name} <${result.login}>`
          : result.login || result.name || "(unknown account)";
      return {
        principal: who,
        // Box's users/me carries no scope list; the live identity IS the verdict.
        scopes: null,
        features: [{ label: "Box folder read", status: "READY" }],
      };
    },
  },
  notion: {
    connector: "notion",
    secretName: "token",
    secretLabel: "integration token",
    async test({ secret }) {
      const token = await secret("token");
      if (!token) throw new Error("no notion token configured");
      const { testNotionAuth } = await import("./notion/auth.ts");
      const result = await testNotionAuth(token);
      const who =
        result.name && result.workspaceName
          ? `${result.name} @ ${result.workspaceName}`
          : result.name || result.workspaceName || "(unknown integration)";
      return {
        principal: who,
        // Notion's users/me carries no scope list; capability is gated by which
        // pages/databases the integration is *shared* into, not by token scopes.
        scopes: null,
        features: [{ label: "Notion page / database read", status: "READY" }],
      };
    },
  },
  jira: {
    connector: "jira",
    secretName: "token",
    secretLabel: "API token / PAT",
    async test({ secret, config }) {
      const token = await secret("token");
      if (!token) throw new Error("no jira token configured");
      const host = asString(config.host);
      if (!host) throw new Error("jira: host is required in config");
      const scheme = asString(config.auth) === "bearer" ? "bearer" : "basic";
      const email = asString(config.email) || undefined;
      const { buildJiraAuth, testJiraAuth } = await import("./jira/auth.ts");
      const auth = buildJiraAuth({ scheme, host, ...(email ? { email } : {}), token });
      const result = await testJiraAuth(auth);
      const who =
        result.displayName && result.email
          ? `${result.displayName} <${result.email}>`
          : result.displayName || result.email || "(unknown account)";
      return {
        principal: who,
        // Jira's /myself carries no scope list; capability is gated by project
        // permissions for the authenticating account, not by token scopes.
        scopes: null,
        features: [{ label: "Jira issue / comment read", status: "READY" }],
      };
    },
  },
};

/** Connectors that expose the generic `auth set` / `auth test` verbs (sorted). */
export function authConnectorNames(): string[] {
  return Object.keys(AUTH_SPECS).sort();
}
