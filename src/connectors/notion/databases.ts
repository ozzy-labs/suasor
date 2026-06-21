/**
 * Notion database discovery for `notion databases` (ADR-0030; the notion port of
 * Slack's `slack conversations` / github's `github repos` / box's `box folders`
 * discovery).
 *
 * Enumerates the databases the integration token can see (`POST /v1/search`
 * filtered to `database` objects) so the operator can discover the database `id`s
 * the notion connector reads without hand-hunting them from the Notion UI —
 * closing the typo→silent-0-results gap (ADR-0007 "no silent wrong answer"). The
 * paste-ready `[connectors.notion]` block carries every discovered id (the plural
 * `databases = [...]` the connector config expects).
 *
 * Import-clean (ADR-0007): no SDK. The default transport uses the global `fetch`
 * (same pattern as `src/connectors/box/folders.ts`), wrapped in the shared
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
import { NOTION_API_VERSION } from "./client.ts";

/** One database surfaced for the discovery CLI. */
export interface NotionDatabase {
  /** Database id — a value `[connectors.notion].databases` accepts. */
  readonly id: string;
  /** Database title (plain text). */
  readonly title: string;
}

/** Result of a discovery sweep: the visible databases, sorted a-z by title. */
export interface DatabasesResult {
  readonly databases: NotionDatabase[];
}

export interface ListDatabasesOptions {
  /** Substring filter over title + id (case-insensitive). */
  readonly filter?: string;
  /** Transport override (tests inject a fake; default lazy-`fetch`). */
  readonly transport?: NotionDatabasesTransport;
  /**
   * Called once per fetched page so a CLI can render an indeterminate progress
   * counter. Best-effort: any throw is ignored so progress never fails the sweep.
   */
  readonly onProgress?: () => void;
}

/** One `POST /v1/search` page fetch, decoupled from `fetch` for tests. */
export type NotionDatabasesTransport = (request: {
  token: string;
  /** Pagination cursor for the next page, or `undefined` for the first page. */
  cursor?: string;
}) => Promise<{ status: number; body: unknown }>;

/** Notion's max page size for `search`. */
const PAGE_SIZE = 100;

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Concatenate a Notion `rich_text[]` / `title[]` array into plain text. */
function plainText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((rt) =>
      rt && typeof rt === "object" ? asString((rt as { plain_text?: unknown }).plain_text) : "",
    )
    .join("");
}

/**
 * Build the default transport: a `POST /v1/search` filtered to databases, run
 * through {@link fetchWithRetry} so a transient 429/5xx is retried (Issue #269).
 * `retry` is injectable (`fetchImpl` / `sleep`) so a test can drive
 * "429 → Retry-After → success" with no real waiting.
 */
export function makeDefaultTransport(retry: FetchWithRetryOptions = {}): NotionDatabasesTransport {
  const opts = { timeoutMs: DEFAULT_CONNECTOR_TIMEOUT_MS, ...retry };
  return async ({ token, cursor }) => {
    const body: Record<string, unknown> = {
      page_size: PAGE_SIZE,
      filter: { property: "object", value: "database" },
      ...(cursor ? { start_cursor: cursor } : {}),
    };
    const res = await fetchWithRetry(
      "https://api.notion.com/v1/search",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Notion-Version": NOTION_API_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
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

const defaultTransport: NotionDatabasesTransport = makeDefaultTransport();

interface SearchPage {
  readonly databases: NotionDatabase[];
  readonly nextCursor?: string;
}

/**
 * Fetch one page of `search` results, keeping only `database` objects.
 *
 * @throws {Error} when the request returns a non-2xx (message carries the HTTP
 *   status + Notion `message`, never the token).
 */
async function fetchPage(
  transport: NotionDatabasesTransport,
  token: string,
  cursor: string | undefined,
): Promise<SearchPage> {
  const { status, body } = await transport({ token, ...(cursor ? { cursor } : {}) });
  const obj = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (status < 200 || status >= 300) {
    const message = asString(obj.message) || `HTTP ${status}`;
    throw new Error(`notion POST /v1/search failed: ${status} ${message}`);
  }
  const results = Array.isArray(obj.results) ? (obj.results as Record<string, unknown>[]) : [];
  const databases = results
    .filter((r) => asString(r.object) === "database" && asString(r.id).length > 0)
    .map((r) => ({ id: asString(r.id), title: plainText(r.title) }));
  const nextCursor =
    obj.has_more === true && typeof obj.next_cursor === "string" ? obj.next_cursor : undefined;
  return { databases, ...(nextCursor ? { nextCursor } : {}) };
}

/**
 * Enumerate the databases the token can see (all pages), sorted a-z by title.
 *
 * @throws {Error} when any `POST /v1/search` returns a non-2xx (message carries
 *   the HTTP status + Notion message, never the token).
 */
export async function listDatabases(
  token: string,
  options: ListDatabasesOptions = {},
): Promise<DatabasesResult> {
  const transport = options.transport ?? defaultTransport;
  // Best-effort progress tick: a throw in the reporter must not fail the sweep.
  const tick = () => {
    try {
      options.onProgress?.();
    } catch {}
  };

  const databases: NotionDatabase[] = [];
  let cursor: string | undefined;
  do {
    const page = await fetchPage(transport, token, cursor);
    tick();
    for (const db of page.databases) databases.push(db);
    cursor = page.nextCursor;
  } while (cursor);

  databases.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));

  let filtered = databases;
  if (options.filter !== undefined && options.filter.length > 0) {
    const needle = options.filter.toLowerCase();
    filtered = databases.filter(
      (d) => d.title.toLowerCase().includes(needle) || d.id.toLowerCase().includes(needle),
    );
  }

  return { databases: filtered };
}

/**
 * Render a `[connectors.notion]` config block the operator can paste straight
 * into `config.toml`. The `databases` array carries every discovered id (a
 * mistyped id silently ingests nothing — the gap this closes, ADR-0030) with a
 * trailing `# <title>` comment for readability.
 */
export function renderConfigBlock(result: DatabasesResult): string[] {
  const entries: ConfigBlockEntry[] = result.databases.map((d) => ({
    value: d.id,
    label: d.title || "(untitled)",
  }));
  return renderConnectorConfigBlock("notion", entries, {
    key: "databases",
    idNote: "databases are Notion database ids — the # comment is just the title",
  });
}
