/**
 * Microsoft Graph connector (ADR-0007). Read-only ingest across the Microsoft
 * 365 surface — Outlook mail, Calendar, OneDrive files, and Teams channel
 * messages — into `SourceRecord`s.
 *
 * - **read-only** — only Graph `GET` collection endpoints are called; nothing is
 *   written back (ADR-0003).
 * - **pagination + fingerprint** — Graph collections are paged via
 *   `@odata.nextLink` (the `/delta` endpoint is *not* used). The connector walks
 *   every page each run and relies on the body fingerprint (sync service
 *   SHA-256) for change detection (FR-ING-3); no per-run cursor is stored, so
 *   `finalize` returns `cursor: null` like other fingerprint-based connectors.
 *   Transient `429` responses are retried by the SDK's default RetryHandler
 *   (`initWithMiddleware`), so the connector does not add its own retry loop.
 * - **body / extraction** — most records carry text bodies (mail/calendar/teams
 *   subject + preview). OneDrive `files` are name-only, but Office/PDF files
 *   (`.docx`/`.xlsx`/`.pptx`/`.pdf`) additionally carry an `extractable` handle
 *   so the shared sync extraction stage (ADR-0024) can fetch their content via
 *   the Graph API (`/drive/items/{id}/content`, read-only) and replace the body
 *   with sidecar-extracted text. Non-extractable files stay name-only. Fetch /
 *   extraction is best-effort: a download or sidecar failure degrades back to
 *   name-only and ingest still succeeds (ADR-0024 §3). Drive content fetch shares
 *   the same connector-agnostic base as `local` / `box` (#243).
 * - **identity** — `msgraph:<resource>:<id>` (cross-source-unique, resource-
 *   prefixed, ADR-0007). `source_type` is one of `ms365_mail`, `ms365_calendar`,
 *   `ms365_file`, `ms365_teams_message`.
 * - **content fingerprint (files)** — for OneDrive `files`, the connector supplies
 *   the DriveItem content hash (`file.hashes.quickXorHash`, else sha256/sha1) as
 *   the delta fingerprint so a content-only change (same filename) surfaces as
 *   `SourceBodyUpdated` and re-extracts (the content-fingerprint prerequisite for
 *   API connectors, ADR-0024 §6). When no hash is reported the fingerprint is
 *   omitted and the sync service falls back to SHA-256-over-body (the filename).
 * - **import-clean** — `@microsoft/microsoft-graph-client` + `@azure/msal-node`
 *   are **lazy-imported inside `sync`**, so building the connector / registry
 *   never pulls the SDKs (ADR-0007, NFR-PRF-1). Top-level imports are limited to
 *   `zod` + the contract + extraction extension set (a pure `Set`, no SDK).
 * - **secrets** — the client secret comes from `ctx.secret("clientSecret")`
 *   (keychain + env override, NFR-PRV-4); tenant/client ids live in config.
 */
import { extname } from "node:path";
import { z } from "zod";
import { EXTRACTABLE_EXTENSIONS } from "../extraction/index.ts";
import type {
  Connector,
  ConnectorConfig,
  SourceRecord,
  SyncContext,
  SyncResult,
} from "./contract.ts";
import { type IsolationResult, syncResourcesIsolated } from "./per-resource.ts";

/** Graph resource families this connector can ingest. */
export const MsGraphResource = z.enum(["mail", "calendar", "files", "teams"]);
export type MsGraphResource = z.infer<typeof MsGraphResource>;

/** `[connectors.ms-graph]` config (docs/design/config.md). */
export const MsGraphConnectorConfig = z.object({
  /** Azure AD tenant id (directory id). */
  tenantId: z.string().min(1).default(""),
  /** App registration (client) id. */
  clientId: z.string().min(1).default(""),
  /** User principal name / id whose mailbox & drive are read (app-only flow). */
  user: z.string().min(1).default("me"),
  /** Resource families to ingest. */
  resources: z.array(MsGraphResource).default(["mail", "calendar"]),
});
export type MsGraphConnectorConfig = z.infer<typeof MsGraphConnectorConfig>;

export const MS_GRAPH_CONNECTOR_NAME = "ms-graph";

/** DriveItem content hashes (any one drives the content fingerprint, ADR-0024 §6). */
interface GraphFileHashes {
  /** OneDrive's native fast hash (preferred when present). */
  quickXorHash?: string;
  sha256Hash?: string;
  sha1Hash?: string;
}

/** Minimal Graph item shape (the fields we map). */
interface GraphItem {
  id: string;
  subject?: string;
  bodyPreview?: string;
  body?: { content?: string };
  name?: string;
  lastModifiedDateTime?: string;
  receivedDateTime?: string;
  start?: { dateTime?: string };
  createdDateTime?: string;
  /** DriveItem byte size (drives the extraction size guard, ADR-0024 §5). */
  size?: number;
  /** DriveItem `file` facet (present on files, absent on folders). */
  file?: { hashes?: GraphFileHashes };
}

/**
 * Pick a stable content hash from a DriveItem `file` facet, preferring OneDrive's
 * native `quickXorHash` and falling back to sha256/sha1. Used as the delta
 * fingerprint so a content-only change re-extracts (ADR-0024 §6). `undefined`
 * when the item is not a file or reports no hash (sync falls back to body hash).
 */
function contentHash(item: GraphItem): string | undefined {
  const h = item.file?.hashes;
  return h?.quickXorHash ?? h?.sha256Hash ?? h?.sha1Hash ?? undefined;
}

/** A Graph collection page (OData). */
interface GraphPage {
  value: GraphItem[];
  "@odata.nextLink"?: string;
}

/**
 * Map a Graph resource family to its (`source_type`, list path) pair. The path
 * is relative to the Graph base; `{user}` is substituted from config.
 */
const RESOURCE_SPEC: Record<
  MsGraphResource,
  { sourceType: string; path: (user: string) => string }
> = {
  mail: {
    sourceType: "ms365_mail",
    path: (u) => `/users/${u}/messages?$top=50&$select=id,subject,bodyPreview,receivedDateTime`,
  },
  calendar: {
    sourceType: "ms365_calendar",
    path: (u) => `/users/${u}/events?$top=50&$select=id,subject,bodyPreview,start`,
  },
  files: {
    sourceType: "ms365_file",
    // `size` + `file` (content hashes) drive the extraction size guard and
    // content fingerprint (ADR-0024 §5/§6) on top of the name-only ingest.
    path: (u) =>
      `/users/${u}/drive/root/children?$top=50&$select=id,name,lastModifiedDateTime,size,file`,
  },
  teams: {
    sourceType: "ms365_teams_message",
    path: (u) => `/users/${u}/chats/getAllMessages?$top=50`,
  },
};

/**
 * Build a `SourceRecord` for one Graph item of a resource family.
 *
 * For the `files` resource, Office/PDF DriveItems additionally carry an
 * `extractable` handle whose `readBytes` lazily downloads the file content via the
 * Graph API; the shared sync extraction stage (ADR-0024) then replaces the body
 * with the sidecar's extracted text for new/changed records. The `fingerprint` is
 * the DriveItem content hash when available, so a content-only change (same
 * filename) surfaces as `SourceBodyUpdated` and re-extracts (ADR-0024 §6). When no
 * hash is reported the fingerprint is omitted and the sync service falls back to
 * SHA-256-over-body (the filename). `readBytes` is lazy — called at most once, and
 * only when extraction actually runs — so non-extractable files and unchanged
 * records pay no download cost.
 */
function toRecord(
  resource: MsGraphResource,
  item: GraphItem,
  client: MsGraphClientLike,
): SourceRecord {
  const spec = RESOURCE_SPEC[resource];
  const title = item.subject ?? item.name ?? "";
  const detail = item.body?.content ?? item.bodyPreview ?? "";
  const body = title && detail ? `${title}\n\n${detail}` : title || detail;
  const observedAt =
    item.lastModifiedDateTime ??
    item.receivedDateTime ??
    item.start?.dateTime ??
    item.createdDateTime ??
    new Date(0).toISOString();

  // Only OneDrive `files` carry binary content to extract. Office/PDF DriveItems
  // with a known `size` get an extraction handle (lazy download) + content
  // fingerprint; everything else stays name-only (ADR-0024).
  const ext = resource === "files" && item.name ? extname(item.name).toLowerCase() : "";
  const extractable =
    resource === "files" && EXTRACTABLE_EXTENSIONS.has(ext) && item.size !== undefined
      ? {
          filename: item.name ?? "",
          byteSize: item.size,
          readBytes: (): Promise<Uint8Array> => client.downloadFile(item.id),
        }
      : undefined;
  const fingerprint = resource === "files" ? contentHash(item) : undefined;

  return {
    externalId: `msgraph:${resource}:${item.id}`,
    sourceType: spec.sourceType,
    body,
    observedAt,
    meta: { resource, id: item.id },
    ...(fingerprint ? { fingerprint } : {}),
    ...(extractable !== undefined ? { extractable } : {}),
  };
}

/**
 * The Graph client surface we depend on: fetch a JSON page for a relative API
 * path, and download one DriveItem's bytes. Declared structurally so tests inject
 * a fake without the SDK and so the real client is lazy-loaded.
 */
export interface MsGraphClientLike {
  /** GET a Graph collection page by relative path (or an absolute nextLink). */
  getPage(path: string): Promise<GraphPage>;
  /** Download one DriveItem's raw bytes (read-only; used by the extraction handle). */
  downloadFile(itemId: string): Promise<Uint8Array>;
}

/**
 * Drain a stream-ish download result (web `ReadableStream`, Node `Readable`, or
 * any async-iterable of byte chunks) into a single `Uint8Array`. The Graph SDK's
 * `getStream()` returns different shapes across runtimes, so we normalize them all
 * here. `undefined` (no content) yields an empty buffer so the caller falls back
 * to name-only.
 */
async function drainStream(stream: unknown): Promise<Uint8Array> {
  if (!stream) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const push = (chunk: unknown) => {
    const bytes =
      chunk instanceof Uint8Array
        ? chunk
        : new Uint8Array(chunk as ArrayBuffer | ArrayLike<number>);
    chunks.push(bytes);
    total += bytes.byteLength;
  };
  // Web ReadableStream (has getReader): pull until done.
  const getReader = (stream as { getReader?: () => ReadableStreamDefaultReader<Uint8Array> })
    .getReader;
  if (typeof getReader === "function") {
    const r = getReader.call(stream);
    for (;;) {
      const { done, value } = await r.read();
      if (done) break;
      if (value) push(value);
    }
  } else {
    // Node Readable / any async iterable of chunks.
    for await (const chunk of stream as AsyncIterable<Uint8Array>) push(chunk);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** How the connector obtains a Graph client (overridable in tests). */
export type MsGraphClientFactory = (auth: {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** User principal whose drive content downloads are scoped to (file fetch). */
  user: string;
}) => Promise<MsGraphClientLike> | MsGraphClientLike;

/**
 * Default factory: lazy-imports `@azure/msal-node` for an app-only token and
 * `@microsoft/microsoft-graph-client` for the request surface. Kept out of the
 * top level so registration stays import-clean (ADR-0007).
 */
const defaultMsGraphClientFactory: MsGraphClientFactory = async ({
  tenantId,
  clientId,
  clientSecret,
  user,
}) => {
  const { ConfidentialClientApplication } = await import("@azure/msal-node");
  const { Client } = await import("@microsoft/microsoft-graph-client");
  const msal = new ConfidentialClientApplication({
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${tenantId}`,
      clientSecret,
    },
  });
  const client = Client.initWithMiddleware({
    authProvider: {
      getAccessToken: async () => {
        const result = await msal.acquireTokenByClientCredential({
          scopes: ["https://graph.microsoft.com/.default"],
        });
        if (!result?.accessToken) throw new Error("ms-graph connector: token acquisition failed");
        return result.accessToken;
      },
    },
  });
  return {
    async getPage(path) {
      // `client.api` accepts both a relative resource path and an absolute
      // `@odata.nextLink`, so the same call covers first page and pagination.
      return (await client.api(path).get()) as GraphPage;
    },
    async downloadFile(itemId) {
      // Read-only content fetch for extraction (ADR-0024). `/content` redirects to
      // a pre-authenticated download URL; `getStream()` follows it and returns the
      // raw bytes as a stream. Drain it (runtime-agnostic) and concatenate.
      const stream = await client.api(`/users/${user}/drive/items/${itemId}/content`).getStream();
      return drainStream(stream);
    },
  };
};

export interface MsGraphConnectorOptions {
  /** Graph client factory override (tests inject a fake; default lazy-imports the SDKs). */
  clientFactory?: MsGraphClientFactory;
}

/** Microsoft Graph connector implementing the read-only contract (ADR-0007). */
class MsGraphConnector implements Connector {
  readonly name = MS_GRAPH_CONNECTOR_NAME;
  readonly sourceType = "ms365";

  /** Per-resource isolation outcome (set when `sync` ran) → finalize summary. */
  private isolation: IsolationResult | null = null;

  constructor(
    private readonly config: MsGraphConnectorConfig,
    private readonly clientFactory: MsGraphClientFactory,
  ) {}

  async *sync(ctx: SyncContext): AsyncIterable<SourceRecord> {
    if (this.config.resources.length === 0) return;

    const clientSecret = await ctx.secret("clientSecret");
    if (!clientSecret) {
      throw new Error(
        "ms-graph connector: no clientSecret configured " +
          "(set SUASOR_CONNECTOR_MS_GRAPH_CLIENTSECRET or store it in the OS keychain)",
      );
    }
    if (!this.config.tenantId || !this.config.clientId) {
      throw new Error("ms-graph connector: tenantId and clientId are required in config");
    }

    const client = await this.clientFactory({
      tenantId: this.config.tenantId,
      clientId: this.config.clientId,
      clientSecret,
      user: this.config.user,
    });
    this.isolation = null;

    // Per-resource error isolation (ADR-0014 generalized, Issue #193): one
    // resource family failing (e.g. mail 403) records a warn and is skipped
    // while the rest stream; only an all-resources failure throws.
    const user = this.config.user;
    const fetchResource = (resource: MsGraphResource): AsyncIterable<SourceRecord> =>
      (async function* () {
        let path: string | undefined = RESOURCE_SPEC[resource].path(user);
        while (path) {
          const page: GraphPage = await client.getPage(path);
          for (const item of page.value ?? []) {
            yield toRecord(resource, item, client);
          }
          path = page["@odata.nextLink"];
        }
      })();

    yield* syncResourcesIsolated(
      this.config.resources,
      ctx,
      (resource) => resource,
      "resource",
      fetchResource,
      (result) => {
        this.isolation = result;
      },
    );
  }

  finalize(): SyncResult {
    // Fingerprint-based change detection; no per-run cursor to persist. A
    // partial resource failure is surfaced so the CLI exits non-zero without
    // discarding the collected records (ADR-0027, Issue #193).
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
 * Build the Microsoft Graph connector from its config slice (validates with Zod).
 * The Graph + MSAL SDKs are not imported here — only when `sync` actually runs.
 */
export function createMsGraphConnector(
  config: ConnectorConfig,
  options: MsGraphConnectorOptions = {},
): Connector {
  const parsed = MsGraphConnectorConfig.parse(config ?? {});
  return new MsGraphConnector(parsed, options.clientFactory ?? defaultMsGraphClientFactory);
}
