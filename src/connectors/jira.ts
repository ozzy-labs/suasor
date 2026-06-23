/**
 * Jira connector (ADR-0007). Read-only ingest of issues, their comments (and the
 * worklog summary folded into the issue body) for the configured projects into
 * `SourceRecord`s — project / ticket demand signal (agile context distinct from
 * GitHub issues) for search / research / next-actions.
 *
 * - **read-only** — only Jira read endpoints are called (`GET /rest/api/3/search`
 *   for JQL, `GET /rest/api/3/issue/{key}/comment` for comments); nothing is ever
 *   written back to Jira (ADR-0003).
 * - **delta** — Jira's search is a delta API via JQL: the connector records the
 *   most recent `fields.updated` seen **per project** and returns a JSON
 *   `{ <project>: <iso-ts> }` map as the next cursor, so each project resumes from
 *   its own high-water mark (FR-ING-3, the Slack per-channel pattern). The next
 *   run issues `project = <key> AND updated >= "<ts>" ORDER BY updated ASC`. A
 *   comment's identity keys off the issue, so a comment whose parent issue's
 *   `updated` advanced is re-seen with the issue.
 * - **identity** — `jira:<host>:<project>:<issue-key>` for issues and
 *   `jira:<host>:<project>:<issue-key>:comment:<id>` for comments
 *   (cross-source-unique, host+project-prefixed, ADR-0007). `source_type` is
 *   `jira_issue` / `jira_comment`.
 * - **body** — an issue's body is `summary` + flattened `description` (ADF / HTML
 *   normalized minimally); a comment's body is its flattened text. A missing
 *   `description` custom field degrades to the summary alone rather than throwing.
 * - **import-clean** — no SDK is imported at the top level; the default client is
 *   `fetch`-based (wrapped in the shared {@link fetchWithRetry} so a transient
 *   429/5xx with `Retry-After` is retried, Issue #269) and built lazily inside
 *   `sync`. Top-level imports are limited to `zod` + the contract + the shared
 *   per-resource helper, so building the connector / registry pulls nothing heavy
 *   (ADR-0007, NFR-PRF-1).
 * - **per-project isolation** — each configured project is one resource: a single
 *   project failing (e.g. a 404 / 403) is recorded and skipped while the rest
 *   stream; only an all-projects failure throws (ADR-0014 generalized, Issue #193).
 *   A failed project's prior cursor is preserved (the failure is not a reset).
 * - **secrets** — the API token / PAT comes from `ctx.secret("token")` (keychain +
 *   env override `SUASOR_CONNECTOR_JIRA_TOKEN`, NFR-PRV-4). The `email` (Cloud
 *   basic auth) is a non-secret config value, never a secret.
 */
import { z } from "zod";
import type {
  Connector,
  ConnectorConfig,
  SourceRecord,
  SyncContext,
  SyncResult,
} from "./contract.ts";
import {
  buildJiraAuth,
  JIRA_HOST_PATTERN,
  type JiraAuthScheme,
  SELF_HOSTED_API_BASE,
} from "./jira/auth.ts";
import {
  DEFAULT_API_BASE,
  DEFAULT_JIRA_CLIENT,
  type JiraAuth,
  type JiraClientFactory,
  type JiraComment,
  type JiraIssue,
} from "./jira/client.ts";

/** `[connectors.jira]` config (docs/design/config.md). */
export const JiraConnectorConfig = z
  .object({
    /** Jira site host, e.g. `example.atlassian.net` (no scheme). */
    host: z
      .string()
      .default("")
      .refine((h) => h === "" || JIRA_HOST_PATTERN.test(h), {
        message:
          "must be a bare host or host:port (no scheme / path / '@' / '?' / '#'), e.g. example.atlassian.net",
      }),
    /**
     * Account email for Cloud HTTP Basic auth (`email:apiToken`). A non-secret
     * config value; the API token itself is the keychain secret. Omit for
     * self-hosted bearer (PAT) auth.
     */
    email: z.string().min(1).optional(),
    /**
     * Project keys whose issues + comments are ingested. Each issue becomes one
     * `jira_issue` record; each comment one `jira_comment`. Discover keys with
     * `suasor jira projects`. Mutually usable with `jql` (an explicit `jql` wins).
     */
    projects: z.array(z.string().min(1)).default([]),
    /**
     * An explicit JQL that overrides the per-project `project = <key>` query. When
     * set, a single sweep runs this JQL (with the saved `updated >=` floor appended
     * under the shared `__jql__` cursor key) instead of one sweep per project.
     */
    jql: z.string().min(1).optional(),
    /**
     * Auth scheme: `basic` (Cloud: email + API token, the default) or `bearer`
     * (self-hosted: a PAT). `bearer` ignores `email` and defaults the REST base to
     * `/rest/api/2`.
     */
    auth: z.enum(["basic", "bearer"]).default("basic"),
  })
  .passthrough();
export type JiraConnectorConfig = z.infer<typeof JiraConnectorConfig>;

export const JIRA_CONNECTOR_NAME = "jira";

/** The cursor key used for the single-sweep `jql` mode (no per-project key). */
const JQL_CURSOR_KEY = "__jql__";

/** A sweep target: a named project, or the explicit-JQL single sweep. */
type JiraResource = { kind: "project"; key: string } | { kind: "jql"; jql: string };

/** Build the issue `SourceRecord` (identity host+project-scoped, ADR-0007). */
export function issueToRecord(host: string, issue: JiraIssue): SourceRecord {
  const body =
    issue.summary && issue.description
      ? `${issue.summary}\n\n${issue.description}`
      : issue.summary || issue.description;
  return {
    externalId: `jira:${host}:${issue.projectKey}:${issue.key}`,
    sourceType: "jira_issue",
    body,
    observedAt: issue.updated,
    meta: {
      kind: "issue",
      host,
      project: issue.projectKey,
      key: issue.key,
      // Status category (new/indeterminate/done) for task read-back (ADR-0036 §6).
      statusCategory: issue.statusCategoryKey ?? "",
      // Raw due date (YYYY-MM-DD) + priority name for due/priority read-back (ADR-0036 §6).
      dueDate: issue.dueDate ?? "",
      priority: issue.priority ?? "",
    },
    // `fields.updated` is the delta signal in place of a content hash.
    fingerprint: issue.updated,
  };
}

/** Build the comment `SourceRecord` (identity scoped under its issue, ADR-0007). */
export function commentToRecord(host: string, comment: JiraComment): SourceRecord {
  return {
    externalId: `jira:${host}:${comment.projectKey}:${comment.issueKey}:comment:${comment.id}`,
    sourceType: "jira_comment",
    body: comment.body,
    observedAt: comment.updated,
    meta: {
      kind: "comment",
      host,
      project: comment.projectKey,
      issueKey: comment.issueKey,
      id: comment.id,
      ...(comment.author ? { author: comment.author } : {}),
    },
    fingerprint: comment.updated,
  };
}

/**
 * Quote a value as a JQL string literal, escaping the JQL metacharacters that
 * can break out of a quoted literal (`\` and `"`). Without this, a project key or
 * a hand-set / persisted cursor value containing a `"` would either malform the
 * query (the resource then fails every run on the same broken JQL) or, worse,
 * inject extra clauses that broaden the read scope beyond the configured project
 * — defeating per-project isolation. JQL escapes both inside a double-quoted
 * literal with a backslash.
 */
export function quoteJql(value: string): string {
  return `"${value.replace(/[\\"]/g, (ch) => `\\${ch}`)}"`;
}

/**
 * Build the per-project JQL: `project = "<key>"` plus the saved `updated >=`
 * floor (so a resumed project only re-fetches what changed since), ordered by
 * `updated ASC` so the high-water mark advances monotonically as records stream.
 * A `since` floor with no prior cursor is omitted (a cold start reads everything
 * the JQL matches). The key and floor are quoted via {@link quoteJql}.
 */
export function buildProjectJql(projectKey: string, floor: string | undefined): string {
  const clauses = [`project = ${quoteJql(projectKey)}`];
  if (floor) clauses.push(`updated >= ${quoteJql(jqlTimestamp(floor))}`);
  return `${clauses.join(" AND ")} ORDER BY updated ASC`;
}

/**
 * Build the explicit-JQL sweep query: the operator's `jql` AND the saved floor,
 * ordered by `updated ASC`. The operator's JQL is wrapped in parentheses so the
 * appended `updated >=` clause cannot be swallowed by a trailing `OR`. The floor
 * literal is quoted via {@link quoteJql}; the operator's `jql` is by-design raw
 * (it is the operator's own query).
 */
export function buildExplicitJql(jql: string, floor: string | undefined): string {
  const base = floor ? `(${jql}) AND updated >= ${quoteJql(jqlTimestamp(floor))}` : jql;
  // Append ORDER BY only when the operator did not specify one (Jira rejects two).
  return /\border\s+by\b/i.test(jql) ? base : `${base} ORDER BY updated ASC`;
}

/**
 * Format an ISO 8601 timestamp for a JQL `updated >=` clause. Jira's JQL date
 * grammar accepts `"yyyy-MM-dd HH:mm"`; an ISO `2026-06-10T12:34:56.000Z` is
 * reshaped to `2026-06-10 12:34` (minute precision is the JQL floor granularity).
 * A value that does not look like an ISO datetime is passed through unchanged
 * (e.g. a bare date) so a hand-set cursor is not mangled.
 */
export function jqlTimestamp(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]}` : iso;
}

/** Parse the resume cursor into a per-project (or `__jql__`) high-water-mark map. */
function parseCursor(raw: string | null): Record<string, string> {
  if (!raw) return {};
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return {};
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    // Unparseable cursor → treat as a fresh start rather than crash.
    return {};
  }
}

/** The later (lexicographically larger ISO) of two optional timestamps. */
function laterTs(a: string | undefined, b: string): string {
  return a !== undefined && a >= b ? a : b;
}

export interface JiraConnectorOptions {
  /** Jira client factory override (tests inject a fake; default is `fetch`-based). */
  clientFactory?: JiraClientFactory;
}

/** Jira connector implementing the read-only contract (ADR-0007). */
class JiraConnector implements Connector {
  readonly name = JIRA_CONNECTOR_NAME;
  readonly sourceType = "jira";

  /** Per-resource (project key / `__jql__`) highest `updated` seen → next cursor. */
  private cursors: Record<string, string> = {};

  /** Per-resource status for this run, used to build the summary + partial flag. */
  private status: { resource: string; status: "ok" | "failed" }[] = [];

  constructor(
    private readonly config: JiraConnectorConfig,
    private readonly clientFactory: JiraClientFactory,
  ) {}

  /** The resources to sweep: each project, or the single explicit-JQL sweep. */
  private resources(): JiraResource[] {
    if (this.config.jql) return [{ kind: "jql", jql: this.config.jql }];
    return this.config.projects.map((key) => ({ kind: "project", key }));
  }

  async *sync(ctx: SyncContext): AsyncIterable<SourceRecord> {
    const resources = this.resources();
    if (resources.length === 0) return;

    const token = await ctx.secret("token");
    if (!token) {
      throw new Error(
        "jira connector: no token configured " +
          "(set SUASOR_CONNECTOR_JIRA_TOKEN or run `suasor jira auth set`)",
      );
    }

    // Resolve auth once (host + Authorization header + REST base). A config error
    // (e.g. missing host / email for basic) throws before any fetch.
    const scheme: JiraAuthScheme = this.config.auth;
    const auth: JiraAuth = buildJiraAuth({
      scheme,
      host: this.config.host,
      ...(this.config.email ? { email: this.config.email } : {}),
      token,
      apiBase: scheme === "bearer" ? SELF_HOSTED_API_BASE : DEFAULT_API_BASE,
    });
    const host = auth.host;

    const client = await this.clientFactory(auth);
    const previous = parseCursor(ctx.cursor);
    // Start empty and seed only configured resources, so cursors for projects
    // removed from config don't accumulate forever.
    this.cursors = {};
    this.status = [];
    let lastError: unknown;
    let okCount = 0;
    const failures: { resource: string; message: string }[] = [];

    for (const resource of resources) {
      const label = resource.kind === "project" ? resource.key : "jql";
      const cursorKey = resource.kind === "project" ? resource.key : JQL_CURSOR_KEY;
      const floor = previous[cursorKey];
      const jql =
        resource.kind === "project"
          ? buildProjectJql(resource.key, floor)
          : buildExplicitJql(resource.jql, floor);

      try {
        let highWater = floor;
        for await (const issue of client.searchIssues(jql)) {
          highWater = laterTs(highWater, issue.updated);
          yield issueToRecord(host, issue);
          // Comments are streamed right after their issue (interleaved), each its
          // own `jira_comment` record. A comment's updated also advances the
          // resource high-water mark so the next run resumes past it.
          for await (const comment of client.issueComments(issue.key, issue.projectKey)) {
            highWater = laterTs(highWater, comment.updated);
            yield commentToRecord(host, comment);
          }
        }
        // Preserve the floor for a resource with no new issues so it is not
        // re-scanned from the very beginning next run.
        if (highWater !== undefined) this.cursors[cursorKey] = highWater;
        okCount += 1;
        this.status.push({ resource: label, status: "ok" });
      } catch (error) {
        // Per-project isolation (ADR-0014 generalized, Issue #193): one project's
        // failure must not abort the rest. Record it for the aggregated warn,
        // preserve its prior cursor (the failure is not a reset), and continue.
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ resource: label, message });
        if (floor !== undefined) this.cursors[cursorKey] = floor;
        this.status.push({ resource: label, status: "failed" });
      }
    }

    // Every resource failed → surface the error rather than reporting a silent
    // empty success (mirrors Slack's all-workspaces-failed throw).
    if (failures.length === resources.length) {
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    // A partial failure: aggregate one warn naming every failed project.
    if (failures.length > 0) {
      const detail = failures.map((f) => `${f.resource} (${f.message})`).join(", ");
      ctx.onWarn?.(
        `${okCount} project(s) OK, ${failures.length} failed (cursor preserved) — ${detail}`,
      );
    }
  }

  finalize(): SyncResult {
    const cursor = Object.keys(this.cursors).length > 0 ? JSON.stringify(this.cursors) : null;
    if (this.status.length === 0) return { cursor };

    const failed = this.status.filter((s) => s.status === "failed");
    const partialFailure = failed.length > 0 && failed.length < this.status.length;
    if (failed.length === 0) return { cursor };

    const parts = this.status.map(({ resource, status }) =>
      status === "failed" ? `${resource}=failed (cursor preserved)` : `${resource}=ok`,
    );
    return { cursor, partialFailure, summaryLines: [`projects: ${parts.join(", ")}`] };
  }
}

/**
 * Build the Jira connector from its config slice (validates with Zod). The
 * `fetch`-based default client is not built here — only when `sync` actually runs
 * — so registration stays import-clean (ADR-0007).
 */
export function createJiraConnector(
  config: ConnectorConfig,
  options: JiraConnectorOptions = {},
): Connector {
  const parsed = JiraConnectorConfig.parse(config ?? {});
  return new JiraConnector(parsed, options.clientFactory ?? DEFAULT_JIRA_CLIENT);
}
