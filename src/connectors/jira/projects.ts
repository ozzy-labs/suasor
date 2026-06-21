/**
 * Jira project discovery for `jira projects` (ADR-0030; the jira port of Slack's
 * `slack conversations` / github's `github repos` / notion's `notion databases`
 * discovery).
 *
 * Enumerates the projects the credential can see (`GET /rest/api/3/project/search`,
 * `startAt`/`maxResults` paginated) so the operator can discover the project keys
 * the jira connector reads without hand-hunting them from the Jira UI — closing the
 * typo→silent-0-results gap (ADR-0007 "no silent wrong answer"). The paste-ready
 * `[connectors.jira]` block carries every discovered key (the plural
 * `projects = [...]` the connector config expects).
 *
 * Import-clean (ADR-0007): no SDK. The default transport uses the global `fetch`
 * (same pattern as `src/connectors/notion/databases.ts`), wrapped in the shared
 * {@link fetchWithRetry} so a transient 429/5xx (with `Retry-After` honoured) is
 * retried rather than aborting the sweep mid-pagination (Issue #269). The token is
 * never echoed in thrown errors.
 */
import {
  DEFAULT_CONNECTOR_TIMEOUT_MS,
  type FetchWithRetryOptions,
  fetchWithRetry,
} from "../../util/retry.ts";
import { type ConfigBlockEntry, renderConnectorConfigBlock } from "../onboard/config-block.ts";
import { DEFAULT_API_BASE, type JiraAuth, shouldStopPaging } from "./client.ts";

/** Jira's max page size for `project/search`. */
const PAGE_SIZE = 100;

/** One project surfaced for the discovery CLI. */
export interface JiraProject {
  /** Project key — a value `[connectors.jira].projects` accepts (e.g. `PROJ`). */
  readonly key: string;
  /** Project display name. */
  readonly name: string;
}

/** Result of a discovery sweep: the visible projects, sorted a-z by key. */
export interface ProjectsResult {
  readonly projects: JiraProject[];
}

export interface ListProjectsOptions {
  /** Substring filter over key + name (case-insensitive). */
  readonly filter?: string;
  /** Transport override (tests inject a fake; default lazy-`fetch`). */
  readonly transport?: JiraProjectsTransport;
  /**
   * Called once per fetched page so a CLI can render an indeterminate progress
   * counter. Best-effort: any throw is ignored so progress never fails the sweep.
   */
  readonly onProgress?: () => void;
}

/** One `GET /project/search` page fetch, decoupled from `fetch` for tests. */
export type JiraProjectsTransport = (request: {
  auth: JiraAuth;
  /** Pagination offset for the next page. */
  startAt: number;
}) => Promise<{ status: number; body: unknown }>;

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Build the default transport: a `GET <apiBase>/project/search`, run through
 * {@link fetchWithRetry} so a transient 429/5xx is retried (Issue #269). `retry`
 * is injectable (`fetchImpl` / `sleep`) so a test can drive
 * "429 → Retry-After → success" with no real waiting.
 */
export function makeDefaultTransport(retry: FetchWithRetryOptions = {}): JiraProjectsTransport {
  const opts = { timeoutMs: DEFAULT_CONNECTOR_TIMEOUT_MS, ...retry };
  return async ({ auth, startAt }) => {
    const apiBase = auth.apiBase ?? DEFAULT_API_BASE;
    const params = new URLSearchParams({
      startAt: String(startAt),
      maxResults: String(PAGE_SIZE),
    });
    const res = await fetchWithRetry(
      `https://${auth.host}${apiBase}/project/search?${params.toString()}`,
      {
        method: "GET",
        headers: { Authorization: auth.authorization, Accept: "application/json" },
      },
      opts,
    );
    let parsed: unknown = {};
    try {
      parsed = await res.json();
    } catch {
      parsed = {};
    }
    return { status: res.status, body: parsed };
  };
}

const defaultTransport: JiraProjectsTransport = makeDefaultTransport();

interface SearchPage {
  readonly projects: JiraProject[];
  /** Raw `total` from the response (may be absent / negative — see shouldStopPaging). */
  readonly rawTotal: unknown;
  /** Number of raw `values` on the page (before key-filtering), for pagination. */
  readonly pageLen: number;
}

/**
 * Fetch one page of `project/search` results.
 *
 * @throws {Error} when the request returns a non-2xx (message carries the HTTP
 *   status + Jira message, never the token).
 */
async function fetchPage(
  transport: JiraProjectsTransport,
  auth: JiraAuth,
  startAt: number,
): Promise<SearchPage> {
  const { status, body } = await transport({ auth, startAt });
  const obj = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (status < 200 || status >= 300) {
    const message =
      (Array.isArray(obj.errorMessages) && asString(obj.errorMessages[0])) ||
      asString(obj.message) ||
      `HTTP ${status}`;
    throw new Error(`jira GET /project/search failed: ${status} ${message}`);
  }
  const values = Array.isArray(obj.values) ? (obj.values as Record<string, unknown>[]) : [];
  const projects = values
    .filter((v) => asString(v.key).length > 0)
    .map((v) => ({ key: asString(v.key), name: asString(v.name) }));
  return { projects, rawTotal: obj.total, pageLen: values.length };
}

/**
 * Enumerate the projects the credential can see (all pages), sorted a-z by key.
 *
 * @throws {Error} when any `GET /project/search` returns a non-2xx (message
 *   carries the HTTP status + Jira message, never the token).
 */
export async function listProjects(
  auth: JiraAuth,
  options: ListProjectsOptions = {},
): Promise<ProjectsResult> {
  const transport = options.transport ?? defaultTransport;
  // Best-effort progress tick: a throw in the reporter must not fail the sweep.
  const tick = () => {
    try {
      options.onProgress?.();
    } catch {}
  };

  const projects: JiraProject[] = [];
  let startAt = 0;
  for (;;) {
    const page = await fetchPage(transport, auth, startAt);
    tick();
    for (const p of page.projects) projects.push(p);
    // Advance by the raw page size (pre key-filter) so a page of all-keyless
    // values still progresses, and stop using the reliable-total / short-page rule.
    startAt += page.pageLen;
    if (shouldStopPaging(page.rawTotal, page.pageLen, startAt, PAGE_SIZE)) break;
  }

  projects.sort((a, b) => a.key.localeCompare(b.key, undefined, { sensitivity: "base" }));

  let filtered = projects;
  if (options.filter !== undefined && options.filter.length > 0) {
    const needle = options.filter.toLowerCase();
    filtered = projects.filter(
      (p) => p.key.toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle),
    );
  }

  return { projects: filtered };
}

/**
 * Render a `[connectors.jira]` config block the operator can paste straight into
 * `config.toml`. The `projects` array carries every discovered key (a mistyped key
 * silently ingests nothing — the gap this closes, ADR-0030) with a trailing
 * `# <name>` comment for readability. A `host` line is included as a placeholder
 * the operator fills in (discovery does not know which host string was typed).
 */
export function renderConfigBlock(result: ProjectsResult, host?: string): string[] {
  const entries: ConfigBlockEntry[] = result.projects.map((p) => ({
    value: p.key,
    label: p.name || "(no name)",
  }));
  return renderConnectorConfigBlock("jira", entries, {
    extras: [
      `host = "${host ?? "<your-site>.atlassian.net"}"`,
      'email = "you@example.com"          # Cloud (basic) auth; omit for self-hosted PAT',
    ],
    key: "projects",
    idNote: "projects are Jira project keys — the # comment is just the name",
  });
}
