/**
 * Per-connector discovery spec SSOT for the generic `<connector> <verb>`
 * discovery CLI verbs (ADR-0030; generalizes Slack's `slack conversations`
 * discovery, ADR-0011, to other connectors).
 *
 * Slack keeps its own richer `slack conversations` (join marks, engagement sort,
 * multi-workspace, ADR-0011/0013/0014); this table covers the other connectors
 * that need an id-discovery seam. The verb surface is data-driven from
 * {@link DISCOVERY_SPECS}: each spec lazy-loads the connector's `fetch`-only
 * discovery leaf (no SDK — import-clean per ADR-0007) and returns the enumerated
 * items plus a paste-ready `[connectors.<name>]` config block.
 *
 * Import-clean: this module's top-level imports are limited to types only — the
 * leaf modules themselves are pulled at discovery time. (Each leaf is
 * `fetch`-only, so even importing them eagerly loads no SDK; keeping them lazy
 * mirrors the rest of the CLI's discipline, NFR-PRF-1.)
 */

/** Resolves a connector secret by name (keychain + env override). */
export type SecretResolver = (name: string) => Promise<string | null>;

/** One enumerated item surfaced by a discovery probe. */
export interface DiscoveryItem {
  /** The id / full name the connector config expects (the value to keep). */
  readonly value: string;
  /** Human-readable label for the listing + config-block comment. */
  readonly label: string;
  /** Optional extra attributes for `--json` output (e.g. visibility, archived). */
  readonly attrs?: Readonly<Record<string, unknown>>;
}

/** Normalized outcome of a connector's discovery probe. */
export interface DiscoveryResult {
  /** Enumerated items, already sorted for display. */
  readonly items: readonly DiscoveryItem[];
  /** Paste-ready `[connectors.<name>]` config-block lines (no trailing newline). */
  readonly configBlock: readonly string[];
}

/** A connector's discovery spec: which verb it adds + the probe that runs it. */
export interface ConnectorDiscoverySpec {
  /** Connector name (CLI verb prefix), e.g. `github`. */
  readonly connector: string;
  /** Discovery verb (the second CLI path segment), e.g. `repos`. */
  readonly verb: string;
  /** One-line CLI usage summary. */
  readonly summary: string;
  /** Noun for the listing header (e.g. `repository`). */
  readonly itemNoun: string;
  /**
   * Run the discovery probe. Resolves secrets + reads config as needed via the
   * injected `secret` resolver and `config` slice, calls the connector's
   * `fetch`-only discovery leaf, and normalizes the result. Throws on failure
   * (the CLI surfaces the message; secrets are never echoed).
   */
  readonly discover: (deps: {
    secret: SecretResolver;
    config: Record<string, unknown>;
    /** Optional filter substring (case-insensitive) over item values. */
    filter?: string;
    /** Best-effort progress tick for a CLI indeterminate spinner. */
    onProgress?: () => void;
  }) => Promise<DiscoveryResult>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Connector → discovery spec (the SSOT for the generic discovery verbs). */
export const DISCOVERY_SPECS: Record<string, ConnectorDiscoverySpec> = {
  github: {
    connector: "github",
    verb: "repos",
    summary: "List repositories the token can see and print a paste-ready config block.",
    itemNoun: "repository",
    async discover({ secret, config, filter, onProgress }) {
      const token = await secret("token");
      if (!token) throw new Error("no github token configured");
      const { listRepos, renderConfigBlock } = await import("./github/repos.ts");
      const baseUrl = asString(config.baseUrl) || undefined;
      const result = await listRepos(token, {
        ...(filter ? { filter } : {}),
        ...(baseUrl ? { baseUrl } : {}),
        ...(onProgress ? { onProgress } : {}),
      });
      const items: DiscoveryItem[] = result.repos.map((r) => ({
        value: r.fullName,
        label: r.isArchived ? `${r.visibility}, archived` : r.visibility,
        attrs: { visibility: r.visibility, archived: r.isArchived },
      }));
      return { items, configBlock: renderConfigBlock(result) };
    },
  },
  google: {
    connector: "google",
    verb: "calendars",
    summary: "List calendars the token can see and print a paste-ready config block.",
    itemNoun: "calendar",
    async discover({ secret, config, filter, onProgress }) {
      const refreshToken = await secret("refreshToken");
      if (!refreshToken) throw new Error("no google refreshToken configured");
      const clientId = asString(config.clientId);
      if (!clientId) throw new Error("google: clientId is required in config");
      const clientSecret = (await secret("clientSecret")) ?? undefined;
      const { listCalendars, renderConfigBlock } = await import("./google/calendars.ts");
      const result = await listCalendars(
        { clientId, refreshToken, ...(clientSecret ? { clientSecret } : {}) },
        {
          ...(filter ? { filter } : {}),
          ...(onProgress ? { onProgress } : {}),
        },
      );
      const items: DiscoveryItem[] = result.calendars.map((c) => {
        const label = [c.summary || "(no summary)", c.timeZone, c.primary ? "primary" : ""]
          .filter((p) => p.length > 0)
          .join(", ");
        return {
          value: c.id,
          label,
          attrs: {
            summary: c.summary,
            timeZone: c.timeZone,
            primary: c.primary,
            accessRole: c.accessRole,
          },
        };
      });
      return { items, configBlock: renderConfigBlock(result) };
    },
  },
};

/** Connectors that expose a discovery verb (sorted). */
export function discoveryConnectorNames(): string[] {
  return Object.keys(DISCOVERY_SPECS).sort();
}
