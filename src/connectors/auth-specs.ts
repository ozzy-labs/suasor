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
 */

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
  /** Per-feature readiness rows (may be empty). */
  readonly features: readonly AuthFeatureReadiness[];
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
  }) => Promise<AuthTestReport>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Map a granted-scopes string to a single self-reported readiness row. */
function scopeReadiness(label: string, scopes: string): AuthFeatureReadiness {
  return {
    label,
    status: scopes.trim().length > 0 ? "READY" : "N/A (no scopes reported)",
  };
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
      return {
        principal: result.login || "(unknown login)",
        scopes: result.scopes.length > 0 ? result.scopes : null,
        features: [scopeReadiness("issue / pull request read", result.scopes)],
      };
    },
  },
  "ms-graph": {
    connector: "ms-graph",
    secretName: "clientSecret",
    secretLabel: "app client secret",
    async test({ secret, config }) {
      const clientSecret = await secret("clientSecret");
      if (!clientSecret) throw new Error("no ms-graph clientSecret configured");
      const tenantId = asString(config.tenantId);
      const clientId = asString(config.clientId);
      if (!tenantId || !clientId) {
        throw new Error("ms-graph: tenantId and clientId are required in config");
      }
      const { testMsGraphAuth } = await import("./ms-graph/auth.ts");
      const result = await testMsGraphAuth({ tenantId, clientId, clientSecret });
      return {
        principal: `app ${clientId} @ tenant ${tenantId}`,
        scopes: result.scope.length > 0 ? result.scope : null,
        features: [scopeReadiness("Graph read (.default app permissions)", result.scope)],
      };
    },
  },
  google: {
    connector: "google",
    secretName: "refreshToken",
    secretLabel: "OAuth refresh token",
    async test({ secret, config }) {
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
      return {
        principal: `client ${clientId}`,
        scopes: result.scope.length > 0 ? result.scope : null,
        features: [scopeReadiness("Workspace read (Drive / Gmail / Calendar)", result.scope)],
      };
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
};

/** Connectors that expose the generic `auth set` / `auth test` verbs (sorted). */
export function authConnectorNames(): string[] {
  return Object.keys(AUTH_SPECS).sort();
}
