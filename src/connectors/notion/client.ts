/**
 * Notion read client for the connector's `sync` path (ADR-0007).
 *
 * Notion's REST API is plain JSON, so rather than pull a heavy SDK this client is
 * `fetch`-based (the same import-clean discipline as the box/google `auth` leaves)
 * and wrapped in the shared {@link fetchWithRetry} so a transient 429/5xx — with
 * `Retry-After` honoured — is retried rather than aborting a sweep mid-pagination
 * (Issue #269). It exposes a structural {@link NotionClientLike} so the connector
 * and tests inject a fake without any network.
 *
 * Read-only (ADR-0003): only Notion's read endpoints are called — `POST /v1/search`
 * and `POST /v1/databases/{id}/query` are Notion's *list* verbs (they take a body),
 * `GET /v1/blocks/{id}/children` reads block text, `GET /v1/pages/{id}` /
 * `GET /v1/databases/{id}` resolve titles. Nothing is mutated.
 *
 * Body extraction recurses a page/row's blocks to a bounded depth with a visited
 * id guard so a synced-block cycle cannot loop forever (Notion lets a block be
 * referenced from multiple parents).
 */
import {
  DEFAULT_CONNECTOR_TIMEOUT_MS,
  type FetchWithRetryOptions,
  fetchWithRetry,
} from "../../util/retry.ts";

/** Notion REST API version pin (sent as `Notion-Version`). */
export const NOTION_API_VERSION = "2022-06-28";
/** Notion's max page size for paginated list endpoints. */
const PAGE_SIZE = 100;
/** Hard cap on blocks fetched per item, a backstop against an unbounded tree. */
const MAX_BLOCKS_PER_ITEM = 5000;

/** A normalized Notion item the connector maps into a `SourceRecord`. */
export type NotionItem =
  | {
      readonly kind: "page";
      readonly id: string;
      /** Plain-text page title. */
      readonly title: string;
      /** Recursive plain-text of the page's blocks. */
      readonly text: string;
      /** `last_edited_time` (ISO 8601) — the delta fingerprint. */
      readonly lastEditedTime: string;
    }
  | {
      readonly kind: "database_item";
      readonly id: string;
      /** Owning database id (scopes the record identity). */
      readonly databaseId: string;
      readonly title: string;
      readonly text: string;
      readonly lastEditedTime: string;
    };

/** The read surface the connector depends on (structural, so tests fake it). */
export interface NotionClientLike {
  /** Stream standalone pages the integration can see (via `search`). */
  pages(depth: number): AsyncIterable<NotionItem>;
  /** Stream the rows of one database (via `databases.query`). */
  databaseItems(databaseId: string, depth: number): AsyncIterable<NotionItem>;
}

/** How the connector obtains a Notion client (overridable in tests). */
export type NotionClientFactory = (token: string) => Promise<NotionClientLike> | NotionClientLike;

/** One low-level Notion request, decoupled from `fetch` so tests inject a fake. */
export type NotionTransport = (request: {
  token: string;
  method: "GET" | "POST";
  /** Path under `https://api.notion.com` (e.g. `/v1/search`). */
  path: string;
  /** JSON body for POST list verbs (omitted for GET). */
  body?: Record<string, unknown>;
}) => Promise<{ status: number; body: unknown }>;

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Build the default `fetch`-based transport, run through {@link fetchWithRetry} so
 * a transient 429/5xx is retried (Issue #269). `retry` is injectable
 * (`fetchImpl` / `sleep`) so a test can drive "429 → Retry-After → success" with
 * no real waiting.
 */
export function makeDefaultTransport(retry: FetchWithRetryOptions = {}): NotionTransport {
  // Default a per-attempt timeout so a hung host cannot pin a bulk-sync worker
  // (Issue #269); a caller-supplied `timeoutMs` still wins.
  const opts = { timeoutMs: DEFAULT_CONNECTOR_TIMEOUT_MS, ...retry };
  return async ({ token, method, path, body }) => {
    const res = await fetchWithRetry(
      `https://api.notion.com${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Notion-Version": NOTION_API_VERSION,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
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
 * Make a request and throw on a non-2xx with the Notion `message` (never the
 * token). Returns the parsed object body.
 */
async function request(
  transport: NotionTransport,
  token: string,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { status, body: raw } = await transport({
    token,
    method,
    path,
    ...(body ? { body } : {}),
  });
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (status < 200 || status >= 300) {
    const message = asString(obj.message) || `HTTP ${status}`;
    throw new Error(`notion ${method} ${path} failed: ${status} ${message}`);
  }
  return obj;
}

/** Concatenate a Notion `rich_text[]` array into plain text. */
function richText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((rt) =>
      rt && typeof rt === "object" ? asString((rt as { plain_text?: unknown }).plain_text) : "",
    )
    .join("");
}

/**
 * Resolve a Notion page/row title from its `properties`. A page's title lives in
 * the property whose `type` is `"title"`; a database row is the same. Falls back
 * to an empty string when no title property is present (e.g. a child page block).
 */
function titleFromProperties(properties: unknown): string {
  if (!properties || typeof properties !== "object") return "";
  for (const value of Object.values(properties as Record<string, unknown>)) {
    if (value && typeof value === "object" && (value as { type?: unknown }).type === "title") {
      return richText((value as { title?: unknown }).title);
    }
  }
  return "";
}

/**
 * Extract the plain-text a single block contributes. Notion stores text under a
 * type-keyed object (e.g. `paragraph.rich_text`); most text blocks follow this
 * shape, so we read `<type>.rich_text` generically. `child_page` carries its title
 * directly. Non-text blocks (images, dividers) contribute nothing.
 */
function blockText(block: Record<string, unknown>): string {
  const type = asString(block.type);
  if (!type) return "";
  if (type === "child_page") {
    const cp = block.child_page;
    return cp && typeof cp === "object" ? asString((cp as { title?: unknown }).title) : "";
  }
  const payload = block[type];
  if (payload && typeof payload === "object") {
    return richText((payload as { rich_text?: unknown }).rich_text);
  }
  return "";
}

/**
 * Recursively gather the plain-text of a block subtree, bounded by `remaining`
 * levels and a `visited` id guard so a synced/duplicated-block cycle cannot loop
 * forever. `remaining` is the number of nesting levels still allowed to be read:
 * the entry call reads the page's direct children at `remaining = page_depth`, and
 * each recursion descends one level (`remaining - 1`) until it hits 0 — so a
 * configured `page_depth` of N reads exactly N levels of nesting (no off-by-one).
 * Each level pages `GET /v1/blocks/{id}/children` to exhaustion; lines are joined
 * with newlines in document order.
 *
 * A `child_page` block is **not** recursed into: that child page is ingested as
 * its own standalone `notion_page` record (Notion `search` returns it
 * independently), so pulling its body into the parent too would duplicate the
 * content across two records. Only the child page's title (from {@link blockText})
 * is kept inline, as a pointer.
 */
async function collectBlockText(
  transport: NotionTransport,
  token: string,
  blockId: string,
  remaining: number,
  visited: Set<string>,
  budget: { remaining: number },
): Promise<string> {
  if (remaining <= 0 || budget.remaining <= 0) return "";
  if (visited.has(blockId)) return ""; // cycle guard
  visited.add(blockId);

  const lines: string[] = [];
  let cursor: string | undefined;
  do {
    const params = new URLSearchParams({ page_size: String(PAGE_SIZE) });
    if (cursor) params.set("start_cursor", cursor);
    const page = await request(
      transport,
      token,
      "GET",
      `/v1/blocks/${encodeURIComponent(blockId)}/children?${params.toString()}`,
    );
    const results = Array.isArray(page.results) ? (page.results as Record<string, unknown>[]) : [];
    for (const block of results) {
      if (budget.remaining <= 0) break;
      budget.remaining -= 1;
      const text = blockText(block);
      if (text) lines.push(text);
      // Recurse one level deeper (a nested list, toggle, etc.), but skip
      // child_page blocks: that page owns its own standalone record, so recursing
      // would ingest its body twice (here and as notion:page:<child>).
      if (block.has_children === true && asString(block.type) !== "child_page") {
        const childId = asString(block.id);
        if (childId) {
          const childText = await collectBlockText(
            transport,
            token,
            childId,
            remaining - 1,
            visited,
            budget,
          );
          if (childText) lines.push(childText);
        }
      }
    }
    cursor =
      page.has_more === true && typeof page.next_cursor === "string" ? page.next_cursor : undefined;
  } while (cursor);

  return lines.join("\n");
}

/** Map one raw Notion object (from search / query) into a normalized item. */
async function toItem(
  transport: NotionTransport,
  token: string,
  raw: Record<string, unknown>,
  depth: number,
  databaseId: string | null,
): Promise<NotionItem | null> {
  const id = asString(raw.id);
  if (!id) return null;
  const lastEditedTime = asString(raw.last_edited_time) || new Date(0).toISOString();
  const title = titleFromProperties(raw.properties);
  const text = await collectBlockText(transport, token, id, depth, new Set<string>(), {
    remaining: MAX_BLOCKS_PER_ITEM,
  });
  if (databaseId) {
    return { kind: "database_item", id, databaseId, title, text, lastEditedTime };
  }
  return { kind: "page", id, title, text, lastEditedTime };
}

/** Build the structural client from a transport (the connector's seam). */
export function makeNotionClient(token: string, transport: NotionTransport): NotionClientLike {
  return {
    async *pages(depth) {
      let cursor: string | undefined;
      do {
        const body: Record<string, unknown> = {
          page_size: PAGE_SIZE,
          // Read-only: `search` filtered to pages is Notion's page-enumeration verb.
          filter: { property: "object", value: "page" },
          ...(cursor ? { start_cursor: cursor } : {}),
        };
        const page = await request(transport, token, "POST", "/v1/search", body);
        const results = Array.isArray(page.results)
          ? (page.results as Record<string, unknown>[])
          : [];
        for (const raw of results) {
          // `search` returns both pages and databases; keep only pages. Pages that
          // belong to a database are also surfaced here, but their identity differs
          // from the db-row identity so they are distinct sources, not duplicates.
          if (asString(raw.object) !== "page") continue;
          const item = await toItem(transport, token, raw, depth, null);
          if (item) yield item;
        }
        cursor =
          page.has_more === true && typeof page.next_cursor === "string"
            ? page.next_cursor
            : undefined;
      } while (cursor);
    },
    async *databaseItems(databaseId, depth) {
      let cursor: string | undefined;
      do {
        const body: Record<string, unknown> = {
          page_size: PAGE_SIZE,
          ...(cursor ? { start_cursor: cursor } : {}),
        };
        const page = await request(
          transport,
          token,
          "POST",
          `/v1/databases/${encodeURIComponent(databaseId)}/query`,
          body,
        );
        const results = Array.isArray(page.results)
          ? (page.results as Record<string, unknown>[])
          : [];
        for (const raw of results) {
          const item = await toItem(transport, token, raw, depth, databaseId);
          if (item) yield item;
        }
        cursor =
          page.has_more === true && typeof page.next_cursor === "string"
            ? page.next_cursor
            : undefined;
      } while (cursor);
    },
  };
}

/** Default factory: a `fetch`-based client (no SDK), built lazily inside `sync`. */
export const DEFAULT_NOTION_CLIENT: NotionClientFactory = (token) =>
  makeNotionClient(token, makeDefaultTransport());
