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
 * Discovery **drift** (`--new`, ADR-0049) is defined on the same registry: each
 * spec declares the config key its ingest scope lives in ({@link DiscoveryScope}),
 * and {@link diffDiscovered} turns "everything the credential sees" into "the
 * ids you have not configured yet". This is ADR-0039's Layer 1 lifted off Slack —
 * the structural gap ("visible to the token, absent from config, therefore never
 * ingested") is identical for github repos / notion databases / jira projects /
 * box folders, and ADR-0030's own Alternatives rejected per-connector bespoke
 * discovery paths for exactly this reason.
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
  /**
   * Optional pre-rendered human listing lines (no trailing newline) for
   * namespaces whose default flat `value (label)` listing is unsuitable — e.g.
   * box folders render an indented id/name tree. When absent the CLI falls back
   * to the generic flat listing over {@link items}.
   */
  readonly listing?: readonly string[];
}

/**
 * How a connector's ingest scope is declared in config, for the generic drift
 * diff (`<connector> <verb> --new`, ADR-0049 — ADR-0039 Layer 1 generalized off
 * Slack onto this registry).
 *
 * Present only when the scope is a **set of ids**, because that is the shape a
 * "visible but not configured" difference is defined over. A connector whose
 * scope is a single value states {@link driftNote} instead, so `--new` refuses
 * with a reason rather than emitting a diff that would flag every non-selected
 * item as drift. (No connector is in that position today — google left it when
 * `calendarId` became `calendarIds`, ADR-0051 — but the opt-out stays declarable
 * so the next single-valued scope has to say so rather than silently lack the
 * verb.)
 */
export interface DiscoveryScope {
  /** Config key inside `[connectors.<name>]` holding the configured ids. */
  readonly key: string;
  /** Short note pasted above the `--new` config fragment (the id format). */
  readonly idNote: string;
  /**
   * Ids the connector ingests when the key is **absent** — i.e. the schema
   * default (google's `calendarIds` defaults to `["primary"]`). Omitted when the
   * schema default is the empty list, which is every other connector.
   *
   * The diff is about what is actually ingested, not about what is literally
   * written: without this, `google calendars --new` would report `primary` as
   * "visible but not configured" on a config that has been ingesting it all
   * along. An **explicit** `[]` still means empty — that is a deliberate "none",
   * not an omission.
   */
  readonly defaultIds?: readonly string[];
  /**
   * Canonicalize an id before comparing config against the API (both sides).
   * Defaults to trim + lowercase. Notion overrides it because the same database
   * is legitimately written with or without the UUID dashes, and a formatting
   * difference is not drift.
   */
  readonly normalizeId?: (value: string) => string;
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
  /** Config scope this connector's drift diff is defined over (see above). */
  readonly scope?: DiscoveryScope;
  /**
   * Why `--new` is not offered, when {@link scope} is absent. Required in that
   * case: an unexplained missing capability is the drift ADR-0030 warned about.
   */
  readonly driftNote?: string;
  /**
   * Whether this verb accepts a `--root <id>` option (a starting node for a
   * tree-shaped namespace, e.g. box folders). When set, the CLI exposes
   * `--root` and threads it into {@link discover} as `root`. Omitted/false for
   * flat namespaces (github repos / google calendars).
   */
  readonly acceptsRoot?: boolean;
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
    /** Root node id for tree-shaped namespaces (only when `acceptsRoot`). */
    root?: string;
    /** Best-effort progress tick for a CLI indeterminate spinner. */
    onProgress?: () => void;
  }) => Promise<DiscoveryResult>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The configured-vs-visible difference for one connector (ADR-0049). */
export interface DiscoveryDiff {
  /** Visible to the credential but absent from config (the actionable half). */
  readonly added: readonly DiscoveryItem[];
  /**
   * Configured but absent from the enumeration — renamed, deleted, or no longer
   * permitted. Empty and **not computed** when the enumeration was deliberately
   * partial (`--filter` / `--root`): a narrowed view cannot distinguish "gone"
   * from "out of view", and claiming otherwise would be the guess this whole
   * layer exists to avoid.
   */
  readonly removed: readonly string[];
  /** Whether {@link removed} was computed at all (false ⇒ partial view). */
  readonly removedComputed: boolean;
}

/** Default id canonicalization for the drift diff: trim + lowercase. */
function defaultNormalizeId(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Read a connector slice's configured id list for a {@link DiscoveryScope}.
 * Non-array / non-string entries are ignored (the slice is already schema-checked
 * upstream; this stays lenient rather than throwing inside a diagnostic).
 *
 * An **absent** key resolves to {@link DiscoveryScope.defaultIds} — what the
 * connector actually ingests in that case — so the diff never reports an id as
 * "not configured" while sync is quietly reading it.
 */
export function configuredIds(config: Record<string, unknown>, scope: DiscoveryScope): string[] {
  const raw = config[scope.key];
  if (raw === undefined) return [...(scope.defaultIds ?? [])];
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string");
}

/**
 * Diff a discovery enumeration against the configured ids (ADR-0049; the
 * connector-generic form of ADR-0039 Layer 1).
 *
 * Pure — no I/O, no config write. `--new` renders the result; nothing is ever
 * ingested or auto-added, preserving the explicit-enumeration data-minimization
 * model ADR-0039 made the SSOT.
 *
 * @param partialView the enumeration was narrowed (`--filter` / `--root`), so
 *   `removed` is not computed. See {@link DiscoveryDiff.removed}.
 */
export function diffDiscovered(
  items: readonly DiscoveryItem[],
  configured: readonly string[],
  scope: DiscoveryScope,
  partialView = false,
): DiscoveryDiff {
  const normalize = scope.normalizeId ?? defaultNormalizeId;
  const configuredSet = new Set(configured.map(normalize));
  const visibleSet = new Set(items.map((item) => normalize(item.value)));
  const added = items.filter((item) => !configuredSet.has(normalize(item.value)));
  if (partialView) return { added, removed: [], removedComputed: false };
  return {
    added,
    removed: configured.filter((id) => !visibleSet.has(normalize(id))),
    removedComputed: true,
  };
}

/** Connector → discovery spec (the SSOT for the generic discovery verbs). */
export const DISCOVERY_SPECS: Record<string, ConnectorDiscoverySpec> = {
  github: {
    connector: "github",
    verb: "repos",
    summary: "List repositories the token can see and print a paste-ready config block.",
    itemNoun: "repository",
    scope: {
      key: "repos",
      idNote: "repos are 'owner/repo' full names — the # comment is just a visibility label",
    },
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
    // ADR-0051 made the ingest scope a *set* (`calendarIds`), which is what a
    // drift diff is defined over — so google joins the generic `--new` instead
    // of declaring why it cannot (ADR-0049 決定 3 opted it out precisely because
    // a single `calendarId` had no configured set to diff).
    scope: {
      key: "calendarIds",
      idNote: "calendars are calendar ids — the # comment is just a label",
      // Unlike every other scope key, an absent `calendarIds` is not "nothing":
      // it is the schema default, and sync reads it.
      defaultIds: ["primary"],
    },
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
  box: {
    connector: "box",
    verb: "folders",
    summary: "List subfolders under a root and print a paste-ready config block.",
    itemNoun: "folder",
    scope: {
      key: "folders",
      idNote: "folders are Box folder ids — the # comment is just the folder name",
    },
    acceptsRoot: true,
    async discover({ secret, filter, root, onProgress }) {
      const token = await secret("token");
      if (!token) throw new Error("no box token configured");
      const { listFolders, renderConfigBlock, renderTree } = await import("./box/folders.ts");
      const result = await listFolders(token, {
        ...(root ? { root } : {}),
        ...(filter ? { filter } : {}),
        ...(onProgress ? { onProgress } : {}),
      });
      const items: DiscoveryItem[] = result.folders.map((f) => ({
        value: f.id,
        label: f.name || "(no name)",
        attrs: { name: f.name, depth: f.depth, parentId: f.parentId },
      }));
      return { items, configBlock: renderConfigBlock(result), listing: renderTree(result) };
    },
  },
  notion: {
    connector: "notion",
    verb: "databases",
    summary: "List databases the token can see and print a paste-ready config block.",
    itemNoun: "database",
    scope: {
      key: "databases",
      idNote: "databases are Notion database ids — the # comment is just the title",
      // Notion accepts a database id with or without the UUID dashes and the API
      // echoes the dashed form; a config written in the compact form is the same
      // database, not drift.
      normalizeId: (value) => value.trim().toLowerCase().replaceAll("-", ""),
    },
    async discover({ secret, filter, onProgress }) {
      const token = await secret("token");
      if (!token) throw new Error("no notion token configured");
      const { listDatabases, renderConfigBlock } = await import("./notion/databases.ts");
      const result = await listDatabases(token, {
        ...(filter ? { filter } : {}),
        ...(onProgress ? { onProgress } : {}),
      });
      const items: DiscoveryItem[] = result.databases.map((d) => ({
        value: d.id,
        label: d.title || "(untitled)",
        attrs: { title: d.title },
      }));
      return { items, configBlock: renderConfigBlock(result) };
    },
  },
  jira: {
    connector: "jira",
    verb: "projects",
    summary: "List projects the credential can see and print a paste-ready config block.",
    itemNoun: "project",
    scope: {
      key: "projects",
      idNote: "projects are Jira project keys — the # comment is just the name",
    },
    async discover({ secret, config, filter, onProgress }) {
      const token = await secret("token");
      if (!token) throw new Error("no jira token configured");
      const host = asString(config.host);
      if (!host) throw new Error("jira: host is required in config");
      const scheme = asString(config.auth) === "bearer" ? "bearer" : "basic";
      const email = asString(config.email) || undefined;
      const { buildJiraAuth } = await import("./jira/auth.ts");
      const { listProjects, renderConfigBlock } = await import("./jira/projects.ts");
      const auth = buildJiraAuth({ scheme, host, ...(email ? { email } : {}), token });
      const result = await listProjects(auth, {
        ...(filter ? { filter } : {}),
        ...(onProgress ? { onProgress } : {}),
      });
      const items: DiscoveryItem[] = result.projects.map((p) => ({
        value: p.key,
        label: p.name || "(no name)",
        attrs: { key: p.key, name: p.name },
      }));
      return { items, configBlock: renderConfigBlock(result, host) };
    },
  },
};

/** Connectors that expose a discovery verb (sorted). */
export function discoveryConnectorNames(): string[] {
  return Object.keys(DISCOVERY_SPECS).sort();
}
