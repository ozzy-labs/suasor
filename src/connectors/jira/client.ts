/**
 * Jira read client for the connector's `sync` path (ADR-0007).
 *
 * Jira's REST API (Cloud `/rest/api/3`, self-hosted `/rest/api/2`) is plain JSON,
 * so rather than pull a heavy SDK this client is `fetch`-based (the same
 * import-clean discipline as the box / notion `auth` leaves) and wrapped in the
 * shared {@link fetchWithRetry} so a transient 429/5xx — with `Retry-After`
 * honoured — is retried rather than aborting a sweep mid-pagination (Issue #269).
 * It exposes a structural {@link JiraClientLike} so the connector and tests inject
 * a fake without any network.
 *
 * Read-only (ADR-0003): only Jira's read endpoints are called —
 * `GET /rest/api/3/search` (JQL search) and `GET /rest/api/3/issue/{key}/comment`
 * (issue comments). Nothing is mutated.
 *
 * Auth is HTTP Basic with `email:apiToken` for Cloud, or a bearer PAT / Basic for
 * self-hosted (the connector resolves which header to send and passes it here).
 * The body is built from `summary` + `description` + comments; an ADF (Atlassian
 * Document Format) or HTML description is flattened to plain text with a minimal
 * normalizer so a missing / non-string `description` custom field degrades to the
 * summary alone rather than throwing.
 */
import {
  DEFAULT_CONNECTOR_TIMEOUT_MS,
  type FetchWithRetryOptions,
  fetchWithRetry,
} from "../../util/retry.ts";

/** Jira's max page size for the JQL search / comment list endpoints. */
const PAGE_SIZE = 100;
/** Hard cap on comments fetched per issue, a backstop against an unbounded thread. */
const MAX_COMMENTS_PER_ISSUE = 5000;

/** A normalized Jira issue the connector maps into a `SourceRecord`. */
export interface JiraIssue {
  /** Issue key (e.g. `PROJ-123`) — the stable, human id within a project. */
  readonly key: string;
  /** Project key the issue belongs to (scopes the record identity). */
  readonly projectKey: string;
  /** Issue summary (the one-line title). */
  readonly summary: string;
  /** Flattened plain-text description (ADF / HTML normalized; may be empty). */
  readonly description: string;
  /** `fields.updated` (ISO 8601) — the per-issue delta signal. */
  readonly updated: string;
  /**
   * Status category key (`new` / `indeterminate` / `done`), from
   * `fields.status.statusCategory.key`. Empty when absent. Used by task read-back
   * to reflect a published task's lifecycle (ADR-0036 §6); the category is
   * workflow-agnostic (custom status *names* map onto these three categories).
   */
  readonly statusCategoryKey?: string;
}

/** A normalized Jira comment the connector maps into a `SourceRecord`. */
export interface JiraComment {
  /** Numeric comment id (unique within the issue). */
  readonly id: string;
  /** Owning issue key (scopes the comment identity under its issue). */
  readonly issueKey: string;
  /** Owning project key (scopes the comment identity under its project). */
  readonly projectKey: string;
  /** Flattened plain-text comment body (ADF / HTML normalized; may be empty). */
  readonly body: string;
  /** `updated` (ISO 8601) — the per-comment delta fingerprint. */
  readonly updated: string;
  /** Display name of the comment author, when present. */
  readonly author: string;
}

/** The read surface the connector depends on (structural, so tests fake it). */
export interface JiraClientLike {
  /**
   * Stream issues matching `jql`, paginated with `startAt`/`maxResults`. The
   * connector passes a per-project JQL (`project = <key> AND updated >= <ts>`).
   */
  searchIssues(jql: string): AsyncIterable<JiraIssue>;
  /** Stream the comments of one issue, paginated with `startAt`/`maxResults`. */
  issueComments(issueKey: string, projectKey: string): AsyncIterable<JiraComment>;
}

/** How the connector obtains a Jira client (overridable in tests). */
export type JiraClientFactory = (auth: JiraAuth) => Promise<JiraClientLike> | JiraClientLike;

/** Resolved auth + host for a Jira request: the `Authorization` header value. */
export interface JiraAuth {
  /** Jira site host, e.g. `example.atlassian.net` (no scheme). */
  readonly host: string;
  /** Full `Authorization` header value (e.g. `Basic <b64>` or `Bearer <pat>`). */
  readonly authorization: string;
  /** REST API base path, defaulting to Cloud's `/rest/api/3` (self-hosted: `/rest/api/2`). */
  readonly apiBase?: string;
}

/** One low-level Jira request, decoupled from `fetch` so tests inject a fake. */
export type JiraTransport = (request: {
  auth: JiraAuth;
  /** Path under `https://<host>` (e.g. `/rest/api/3/search?jql=...`). */
  path: string;
}) => Promise<{ status: number; body: unknown }>;

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Default REST API base path (Jira Cloud). Self-hosted overrides via config. */
export const DEFAULT_API_BASE = "/rest/api/3";

/**
 * Flatten an Atlassian Document Format (ADF) node tree, an HTML string, or a
 * plain string into plain text. ADF (`{ type, content: [...] }`) is walked
 * depth-first concatenating every `text` leaf, with block-level nodes
 * (`paragraph` / `heading` / list items) separated by newlines. An HTML / plain
 * string has its tags stripped and entities left as-is (minimal normalization per
 * the issue: "ADF/HTML→text 正規化は最小限"). A missing / non-object / non-string
 * value yields an empty string so a missing custom field never throws.
 */
export function flattenRichText(value: unknown): string {
  if (typeof value === "string") return stripHtml(value).trim();
  if (!value || typeof value !== "object") return "";
  const lines: string[] = [];
  collectAdf(value as Record<string, unknown>, lines);
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Block-level ADF node types whose content is emitted on its own line. */
const ADF_BLOCK_TYPES = new Set([
  "paragraph",
  "heading",
  "blockquote",
  "listItem",
  "codeBlock",
  "tableRow",
]);

/** Walk an ADF node, appending text leaves and breaking lines at block nodes. */
function collectAdf(node: Record<string, unknown>, lines: string[]): void {
  const type = asString(node.type);
  if (type === "text") {
    const text = asString(node.text);
    if (text) appendInline(lines, text);
    return;
  }
  if (type === "hardBreak") {
    appendInline(lines, "\n");
    return;
  }
  const content = Array.isArray(node.content) ? node.content : [];
  const isBlock = ADF_BLOCK_TYPES.has(type);
  if (isBlock) lines.push("");
  for (const child of content) {
    if (child && typeof child === "object") collectAdf(child as Record<string, unknown>, lines);
  }
}

/** Append inline text to the current (last) line, starting one if needed. */
function appendInline(lines: string[], text: string): void {
  if (lines.length === 0) lines.push("");
  lines[lines.length - 1] = `${lines[lines.length - 1]}${text}`;
}

/** Strip HTML tags and collapse runs of whitespace (minimal HTML→text). */
function stripHtml(html: string): string {
  if (!html.includes("<")) return html;
  return html
    .replace(/<br\s*\/?>(?=)/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/[ \t]+\n/g, "\n");
}

/**
 * Build the default `fetch`-based transport, run through {@link fetchWithRetry} so
 * a transient 429/5xx is retried (Issue #269). `retry` is injectable
 * (`fetchImpl` / `sleep`) so a test can drive "429 → Retry-After → success" with
 * no real waiting.
 */
export function makeDefaultTransport(retry: FetchWithRetryOptions = {}): JiraTransport {
  // Default a per-attempt timeout so a hung host cannot pin a bulk-sync worker
  // (Issue #269); a caller-supplied `timeoutMs` still wins.
  const opts = { timeoutMs: DEFAULT_CONNECTOR_TIMEOUT_MS, ...retry };
  return async ({ auth, path }) => {
    const res = await fetchWithRetry(
      `https://${auth.host}${path}`,
      {
        method: "GET",
        headers: {
          Authorization: auth.authorization,
          Accept: "application/json",
        },
      },
      opts,
    );
    let parsed: unknown = {};
    try {
      parsed = await res.json();
    } catch {
      // Non-JSON error body (e.g. an HTML 5xx) → leave empty; status drives it.
      parsed = {};
    }
    return { status: res.status, body: parsed };
  };
}

/**
 * Make a request and throw on a non-2xx with the Jira error message (never the
 * credential). Jira returns errors as `{ errorMessages: [...] }` or
 * `{ errors: {...} }`. Returns the parsed object body.
 */
async function request(
  transport: JiraTransport,
  auth: JiraAuth,
  path: string,
): Promise<Record<string, unknown>> {
  const { status, body: raw } = await transport({ auth, path });
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (status < 200 || status >= 300) {
    throw new Error(`jira GET ${path.split("?")[0]} failed: ${status} ${jiraErrorMessage(obj)}`);
  }
  return obj;
}

/** Extract a human-readable message from a Jira error body (never the token). */
function jiraErrorMessage(obj: Record<string, unknown>): string {
  if (Array.isArray(obj.errorMessages) && obj.errorMessages.length > 0) {
    return obj.errorMessages.map((m) => asString(m)).join("; ");
  }
  if (obj.errors && typeof obj.errors === "object") {
    const parts = Object.entries(obj.errors as Record<string, unknown>).map(
      ([k, v]) => `${k}: ${asString(v)}`,
    );
    if (parts.length > 0) return parts.join("; ");
  }
  return asString(obj.message) || "request failed";
}

/**
 * Decide whether a paginated sweep should stop after this page. Termination on
 * `startAt >= total` is only used when `total` is a **reliable** count (a
 * non-negative number): Jira Cloud's newer search can report `total: -1`
 * (approximate-count mode) or omit it, and trusting a negative/absent total would
 * truncate the sweep after page 1 and silently drop the rest (ADR-0007 "no silent
 * wrong answer"). When the total is unreliable, fall back to the page-shape signal:
 * stop only once a page comes back empty or short (fewer than `maxResults`).
 */
export function shouldStopPaging(
  rawTotal: unknown,
  pageLen: number,
  startAt: number,
  maxResults: number,
): boolean {
  if (pageLen === 0) return true;
  const hasReliableTotal = typeof rawTotal === "number" && rawTotal >= 0;
  if (hasReliableTotal) return startAt >= rawTotal;
  // Unknown/negative total: a short page is the last page; a full page may have more.
  return pageLen < maxResults;
}

/** Project key from an issue `key` (`PROJ-123` → `PROJ`); empty when malformed. */
export function projectKeyOf(issueKey: string): string {
  const dash = issueKey.lastIndexOf("-");
  return dash > 0 ? issueKey.slice(0, dash) : "";
}

/** Map one raw search-result issue into a normalized {@link JiraIssue}. */
function toIssue(raw: Record<string, unknown>): JiraIssue | null {
  const key = asString(raw.key);
  if (!key) return null;
  const fields =
    raw.fields && typeof raw.fields === "object" ? (raw.fields as Record<string, unknown>) : {};
  const projectKey =
    (fields.project && typeof fields.project === "object"
      ? asString((fields.project as Record<string, unknown>).key)
      : "") || projectKeyOf(key);
  return {
    key,
    projectKey,
    summary: asString(fields.summary),
    // A missing / null `description` (a non-required custom field) flattens to "".
    description: flattenRichText(fields.description),
    updated: asString(fields.updated) || new Date(0).toISOString(),
    statusCategoryKey: statusCategoryOf(fields.status),
  };
}

/** Extract `status.statusCategory.key` (`new`/`indeterminate`/`done`), or "" when absent. */
function statusCategoryOf(status: unknown): string {
  if (!status || typeof status !== "object") return "";
  const cat = (status as Record<string, unknown>).statusCategory;
  if (!cat || typeof cat !== "object") return "";
  return asString((cat as Record<string, unknown>).key);
}

/** Map one raw comment object into a normalized {@link JiraComment}. */
function toComment(
  raw: Record<string, unknown>,
  issueKey: string,
  projectKey: string,
): JiraComment | null {
  const id = asString(raw.id);
  if (!id) return null;
  const author =
    raw.author && typeof raw.author === "object"
      ? asString((raw.author as Record<string, unknown>).displayName)
      : "";
  return {
    id,
    issueKey,
    projectKey,
    body: flattenRichText(raw.body),
    updated: asString(raw.updated) || asString(raw.created) || new Date(0).toISOString(),
    author,
  };
}

/** Build the structural client from a transport (the connector's seam). */
export function makeJiraClient(auth: JiraAuth, transport: JiraTransport): JiraClientLike {
  const apiBase = auth.apiBase ?? DEFAULT_API_BASE;
  return {
    async *searchIssues(jql) {
      let startAt = 0;
      for (;;) {
        const params = new URLSearchParams({
          jql,
          startAt: String(startAt),
          maxResults: String(PAGE_SIZE),
          // Only the fields we read, to keep payloads small (project for identity).
          fields: "summary,description,updated,project,status",
        });
        const page = await request(transport, auth, `${apiBase}/search?${params.toString()}`);
        const issues = Array.isArray(page.issues) ? (page.issues as Record<string, unknown>[]) : [];
        for (const raw of issues) {
          const issue = toIssue(raw);
          if (issue) yield issue;
        }
        startAt += issues.length;
        if (shouldStopPaging(page.total, issues.length, startAt, PAGE_SIZE)) break;
      }
    },
    async *issueComments(issueKey, projectKey) {
      let startAt = 0;
      let fetched = 0;
      for (;;) {
        const params = new URLSearchParams({
          startAt: String(startAt),
          maxResults: String(PAGE_SIZE),
        });
        const page = await request(
          transport,
          auth,
          `${apiBase}/issue/${encodeURIComponent(issueKey)}/comment?${params.toString()}`,
        );
        const comments = Array.isArray(page.comments)
          ? (page.comments as Record<string, unknown>[])
          : [];
        for (const raw of comments) {
          if (fetched >= MAX_COMMENTS_PER_ISSUE) return;
          fetched += 1;
          const comment = toComment(raw, issueKey, projectKey);
          if (comment) yield comment;
        }
        startAt += comments.length;
        if (shouldStopPaging(page.total, comments.length, startAt, PAGE_SIZE)) break;
      }
    },
  };
}

/** Default factory: a `fetch`-based client (no SDK), built lazily inside `sync`. */
export const DEFAULT_JIRA_CLIENT: JiraClientFactory = (auth) =>
  makeJiraClient(auth, makeDefaultTransport());
