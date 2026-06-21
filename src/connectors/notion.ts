/**
 * Notion connector (ADR-0007). Read-only ingest of the Notion knowledge base —
 * standalone pages and the rows of shared databases — into `SourceRecord`s.
 *
 * - **read-only** — only Notion `GET`/`POST`-query read endpoints are called
 *   (`search`/`databases.query`/`blocks.children.list`/`pages.retrieve`); nothing
 *   is ever written back (ADR-0003). The POSTs are Notion's read **query** verbs
 *   (its list endpoints take a body), not mutations (bytes flow "external → here").
 * - **delta** — Notion exposes no delta/cursor API, so change detection keys off a
 *   `last_edited_time` **content fingerprint** (FR-ING-3): a page/row whose body
 *   text is unchanged but whose `last_edited_time` advanced still re-ingests, and
 *   an unchanged `last_edited_time` is a no-op. `finalize` returns `cursor: null`.
 * - **identity** — `notion:page:<id>` for standalone pages and
 *   `notion:db:<db-id>:item:<row-id>` for database rows (cross-source-unique,
 *   ADR-0007). `source_type` is `notion_page` / `notion_database_item`.
 * - **body** — the page/row title plus the recursive plain-text of its blocks
 *   (`GET /v1/blocks/{id}/children`, paginated), bounded by a depth limit and a
 *   visited-id guard so a synced/duplicated block cycle cannot loop forever.
 * - **import-clean** — no SDK is imported at the top level; the default client is
 *   `fetch`-based (wrapped in the shared {@link fetchWithRetry} so a transient
 *   429/5xx with `Retry-After` is retried, Issue #269) and built lazily inside
 *   `sync`. Top-level imports are limited to `zod` + the contract + the shared
 *   retry helper (a pure util, no SDK), so building the connector / registry pulls
 *   nothing heavy (ADR-0007, NFR-PRF-1).
 * - **per-resource isolation** — each configured database is one resource: a
 *   single database failing (e.g. a 404 / 403) is recorded and skipped while the
 *   rest stream; only an all-resources failure throws (ADR-0014 generalized,
 *   Issue #193). Standalone-page discovery is its own resource.
 * - **secrets** — the integration token comes from `ctx.secret("token")`
 *   (keychain + env override `SUASOR_CONNECTOR_NOTION_TOKEN`, NFR-PRV-4).
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
  DEFAULT_NOTION_CLIENT,
  type NotionClientFactory,
  type NotionItem,
} from "./notion/client.ts";
import { type IsolationResult, syncResourcesIsolated } from "./per-resource.ts";

/** Default recursive block depth when `page_depth` is not configured. */
export const DEFAULT_PAGE_DEPTH = 10;

/** `[connectors.notion]` config (docs/design/config.md). */
export const NotionConnectorConfig = z
  .object({
    /**
     * Database ids whose rows are ingested. Each row becomes one
     * `notion_database_item` record. Discover them with `suasor notion databases`.
     */
    databases: z.array(z.string().min(1)).default([]),
    /**
     * Max block-recursion depth when extracting a page/row body (a child page
     * counts as one level). Defaults to {@link DEFAULT_PAGE_DEPTH}; bounded so a
     * deep / cyclic tree cannot walk forever.
     */
    page_depth: z.number().int().positive().default(DEFAULT_PAGE_DEPTH),
    /**
     * Also ingest standalone pages the integration can see via Notion `search`
     * (pages not belonging to a configured database). Defaults to `true`.
     */
    pages: z.boolean().default(true),
  })
  .passthrough();
export type NotionConnectorConfig = z.infer<typeof NotionConnectorConfig>;

export const NOTION_CONNECTOR_NAME = "notion";

/** The two Notion resource kinds this connector ingests. */
export type NotionResource = { kind: "pages" } | { kind: "database"; id: string };

/**
 * Build a `SourceRecord` for one Notion item. The fingerprint is the item's
 * `last_edited_time` (Notion has no delta API; FR-ING-3): a content edit advances
 * it, so an unchanged body whose `last_edited_time` moved still re-ingests, and an
 * unchanged time is a no-op. Database rows are db-scoped in their identity so the
 * same row id under two databases never collides (ADR-0007).
 */
export function toRecord(item: NotionItem): SourceRecord {
  const externalId =
    item.kind === "page"
      ? `notion:page:${item.id}`
      : `notion:db:${item.databaseId}:item:${item.id}`;
  const sourceType = item.kind === "page" ? "notion_page" : "notion_database_item";
  const body = item.title && item.text ? `${item.title}\n\n${item.text}` : item.title || item.text;
  return {
    externalId,
    sourceType,
    body,
    observedAt: item.lastEditedTime,
    meta:
      item.kind === "page"
        ? { kind: "page", id: item.id }
        : { kind: "database_item", id: item.id, databaseId: item.databaseId },
    // last_edited_time fingerprint: the delta signal in place of a cursor API.
    fingerprint: item.lastEditedTime,
  };
}

export interface NotionConnectorOptions {
  /** Notion client factory override (tests inject a fake; default is `fetch`-based). */
  clientFactory?: NotionClientFactory;
}

/** Notion connector implementing the read-only contract (ADR-0007). */
class NotionConnector implements Connector {
  readonly name = NOTION_CONNECTOR_NAME;
  readonly sourceType = "notion";

  /** Per-resource isolation outcome (set when `sync` ran) → finalize summary. */
  private isolation: IsolationResult | null = null;

  constructor(
    private readonly config: NotionConnectorConfig,
    private readonly clientFactory: NotionClientFactory,
  ) {}

  /** The resources to sweep: standalone pages (optional) + each database. */
  private resources(): NotionResource[] {
    const resources: NotionResource[] = [];
    if (this.config.pages) resources.push({ kind: "pages" });
    for (const id of this.config.databases) resources.push({ kind: "database", id });
    return resources;
  }

  async *sync(ctx: SyncContext): AsyncIterable<SourceRecord> {
    const resources = this.resources();
    if (resources.length === 0) return;

    const token = await ctx.secret("token");
    if (!token) {
      throw new Error(
        "notion connector: no token configured " +
          "(set SUASOR_CONNECTOR_NOTION_TOKEN or store it in the OS keychain)",
      );
    }

    const client = await this.clientFactory(token);
    this.isolation = null;
    const depth = this.config.page_depth;

    // Per-resource error isolation (ADR-0014 generalized, Issue #193): one
    // database (or the page sweep) failing records a warn and is skipped while the
    // rest stream; only an all-resources failure throws.
    const fetchResource = (resource: NotionResource): AsyncIterable<SourceRecord> =>
      (async function* () {
        const items =
          resource.kind === "pages"
            ? client.pages(depth)
            : client.databaseItems(resource.id, depth);
        for await (const item of items) {
          yield toRecord(item);
        }
      })();

    yield* syncResourcesIsolated(
      resources,
      ctx,
      (resource) => (resource.kind === "pages" ? "pages" : `db:${resource.id}`),
      "resource",
      fetchResource,
      (result) => {
        this.isolation = result;
      },
    );
  }

  finalize(): SyncResult {
    // Fingerprint-based change detection (last_edited_time); no per-run cursor to
    // persist. A partial resource failure is surfaced so the CLI exits non-zero
    // without discarding the collected records (ADR-0027, Issue #193).
    const iso = this.isolation;
    if (iso?.partialFailure) {
      return {
        cursor: null,
        partialFailure: true,
        ...(iso.summaryLines ? { summaryLines: iso.summaryLines } : {}),
      };
    }
    return { cursor: null };
  }
}

/**
 * Build the Notion connector from its config slice (validates with Zod). The
 * `fetch`-based default client is not built here — only when `sync` actually runs
 * — so registration stays import-clean (ADR-0007).
 */
export function createNotionConnector(
  config: ConnectorConfig,
  options: NotionConnectorOptions = {},
): Connector {
  const parsed = NotionConnectorConfig.parse(config ?? {});
  return new NotionConnector(parsed, options.clientFactory ?? DEFAULT_NOTION_CLIENT);
}
