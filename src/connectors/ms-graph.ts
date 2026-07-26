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
 *   prefixed, ADR-0007), or `msgraph:<account>:<resource>:<id>` for a named
 *   account (ADR-0050). `source_type` is one of `ms365_mail`, `ms365_calendar`,
 *   `ms365_file`, `ms365_teams_message`.
 * - **multi-account** — `[connectors.ms-graph.accounts.<account>]` ingests more
 *   than one tenant / mailbox in one pass (ADR-0050), each with its own
 *   `clientSecret` (`connector:ms-graph:<account>:clientSecret`), its own
 *   `tenantId` / `clientId` / `user`, and per-account error isolation. A config
 *   with no `accounts` table is exactly one unprefixed `default` account.
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
  CredentialRequirement,
  SourceRecord,
  SyncContext,
  SyncResult,
} from "./contract.ts";
import type { ConnectorManifest } from "./manifest.ts";
import {
  type AccountIsolationResult,
  type AccountSlice,
  accountIdPrefix,
  accountSecretName,
  accountSlices,
  accountsRecord,
  syncAccountsIsolated,
} from "./multi-account.ts";
import { syncResourcesIsolated } from "./per-resource.ts";

/** Graph resource families this connector can ingest. */
export const MsGraphResource = z.enum(["mail", "calendar", "files", "teams"]);
export type MsGraphResource = z.infer<typeof MsGraphResource>;

/**
 * Settings for **one** Microsoft 365 account. Every key here is per-account: a
 * second account is typically a different tenant with its own app registration
 * and its own `user` (ADR-0050).
 */
const MsGraphAccountSettings = z.object({
  /** Azure AD tenant id (directory id). */
  tenantId: z.string().min(1).default(""),
  /** App registration (client) id. */
  clientId: z.string().min(1).default(""),
  /**
   * User principal name (`someone@contoso.com`) or object id whose mailbox,
   * calendar, drive and chats are read.
   *
   * **No default** (ADR-0051). It used to default to `"me"`, which is only
   * meaningful on a *delegated* token, where the signed-in user resolves it.
   * This connector authenticates app-only (client credentials, see
   * `ms-graph/auth.ts`) and there is no signed-in user, so Graph reads `me` as a
   * literal user id and answers 404 — an install that never set `user` synced
   * nothing, with the default itself as the cause. An empty value is therefore
   * declared in the manifest's `requiredSettings` and reported by `doctor` /
   * sync pre-flight, instead of shipping a value that cannot work.
   */
  user: z.string().min(1).default(""),
  /** Resource families to ingest. */
  resources: z.array(MsGraphResource).default(["mail", "calendar"]),
  /**
   * The operator's own email addresses (ADR-0043 決定 2). Empty ⇒ no email
   * demand is derived at all. See the google connector for why this is
   * configured rather than read from the API.
   */
  self_addresses: z.array(z.string().min(1)).default([]),
});
export type MsGraphAccountSettings = z.infer<typeof MsGraphAccountSettings>;

/**
 * `[connectors.ms-graph]` config (docs/design/config.md). The flat keys configure
 * the single `default` account **and** act as inherited defaults for every entry
 * of the optional `[connectors.ms-graph.accounts.<account>]` table (ADR-0050).
 */
export const MsGraphConnectorConfig = MsGraphAccountSettings.extend({
  accounts: accountsRecord(MsGraphAccountSettings.partial().strict()),
});
export type MsGraphConnectorConfig = z.infer<typeof MsGraphConnectorConfig>;

export const MS_GRAPH_CONNECTOR_NAME = "ms-graph";

/** Credential precondition enforced centrally by the sync service (Issue #440). */
const MS_GRAPH_CREDENTIALS: CredentialRequirement = {
  secretNames: ["clientSecret"],
  missingMessage:
    "ms-graph connector: no clientSecret configured " +
    "(set SUASOR_CONNECTOR_MS_GRAPH_CLIENTSECRET or store it in the OS keychain)",
};

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
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  isAllDay?: boolean;
  isOrganizer?: boolean;
  responseStatus?: { response?: string };
  attendees?: Array<{ type?: string; emailAddress?: { address?: string } }>;
  hasAttachments?: boolean;
  seriesMasterId?: string;
  createdDateTime?: string;
  /** DriveItem byte size (drives the extraction size guard, ADR-0024 §5). */
  size?: number;
  /** Mail fields (ADR-0043 決定 1). */
  conversationId?: string;
  from?: { emailAddress?: { address?: string } };
  toRecipients?: Array<{ emailAddress?: { address?: string } }>;
  ccRecipients?: Array<{ emailAddress?: { address?: string } }>;
  isRead?: boolean;
  internetMessageHeaders?: Array<{ name?: string; value?: string }>;
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

/** Milliseconds in a day — the calendar window is expressed in days. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Rolling calendar ingest window (ADR-0044 決定 1), matching google's: past for
 * follow-up, future for preparation.
 */
export const CALENDAR_WINDOW_PAST_DAYS = 30;
export const CALENDAR_WINDOW_FUTURE_DAYS = 90;

function calendarWindowStart(): string {
  return new Date(Date.now() - CALENDAR_WINDOW_PAST_DAYS * DAY_MS).toISOString();
}
function calendarWindowEnd(): string {
  return new Date(Date.now() + CALENDAR_WINDOW_FUTURE_DAYS * DAY_MS).toISOString();
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
    // The extra $select fields are the email-demand signal (ADR-0043 決定 1):
    // no additional requests, just stop discarding what the API already returns.
    path: (u) =>
      `/users/${u}/messages?$top=50&$select=id,subject,bodyPreview,receivedDateTime,` +
      "conversationId,from,toRecipients,ccRecipients,isRead,internetMessageHeaders",
  },
  calendar: {
    sourceType: "ms365_calendar",
    // `calendarView` — NOT `/events` (ADR-0044 決定 1). `/events` returns
    // recurring *series masters*, so a weekly standup arrived as one event
    // starting years ago; calendarView expands occurrences over a window, which
    // is what google's `singleEvents: true` already did.
    path: (u) =>
      `/users/${u}/calendarView?startDateTime=${calendarWindowStart()}` +
      `&endDateTime=${calendarWindowEnd()}&$top=50` +
      "&$select=id,subject,bodyPreview,body,start,end,isAllDay,isOrganizer,responseStatus," +
      "attendees,hasAttachments,seriesMasterId,lastModifiedDateTime",
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
  account: AccountSlice,
): SourceRecord {
  const spec = RESOURCE_SPEC[resource];
  const title = item.subject ?? item.name ?? "";
  const detail = item.body?.content ?? item.bodyPreview ?? "";
  const body = title && detail ? `${title}\n\n${detail}` : title || detail;
  // Modification time, never the start time: conflating them is what made a
  // "next week's meetings" filter actually select recently-*edited* events
  // (ADR-0044 決定 1). Event times live in `meta.start` / `meta.end`.
  const observedAt =
    item.lastModifiedDateTime ??
    item.receivedDateTime ??
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
    // Named accounts namespace the id (ADR-0050): Graph message / event ids are
    // scoped to a mailbox, so two accounts would otherwise collide. `default`
    // stays unprefixed so an existing install's lineage holds.
    externalId: `msgraph:${accountIdPrefix(account)}${resource}:${item.id}`,
    sourceType: spec.sourceType,
    body,
    observedAt,
    meta: {
      resource,
      id: item.id,
      // Only for an explicitly declared account (see the google connector).
      ...(account.declared ? { account: account.name } : {}),
      ...(resource === "calendar" ? calendarMeta(item) : {}),
      ...(resource === "mail" ? mailMeta(item) : {}),
    },
    ...(fingerprint ? { fingerprint } : {}),
    ...(extractable !== undefined ? { extractable } : {}),
  };
}

/**
 * Connector-neutral calendar facts for a Graph event (ADR-0044 決定 1) — the
 * same key names google emits, so the demand derivation needs one SQL branch
 * rather than one per connector.
 */
function calendarMeta(item: GraphItem): Record<string, unknown> {
  const self = item.attendees?.find((a) => a.type === "required" || a.type === "optional");
  const response = item.responseStatus?.response ?? "";
  return {
    start: normalizeInstant(item.start?.dateTime),
    end: normalizeInstant(item.end?.dateTime),
    allDay: item.isAllDay === true,
    role:
      item.isOrganizer === true
        ? "organizer"
        : self === undefined
          ? "none"
          : self.type === "optional"
            ? "optional"
            : "required",
    response: ["accepted", "declined", "tentative"].includes(response) ? response : "none",
    // Count only — never the addresses (ADR-0003 content minimization).
    attendees: item.attendees?.length ?? 0,
    hasAgenda: (item.body?.content ?? item.bodyPreview ?? "").trim().length > 0,
    hasAttachments: item.hasAttachments === true,
    recurring: item.seriesMasterId != null,
  };
}

/**
 * Connector-neutral mail facts for a Graph message (ADR-0043 決定 1) — the same
 * key names Gmail emits, so the demand derivation needs one SQL branch.
 */
function mailMeta(item: GraphItem): Record<string, unknown> {
  const addr = (a?: { emailAddress?: { address?: string } }) =>
    (a?.emailAddress?.address ?? "").trim().toLowerCase();
  const headerNames = new Set(
    (item.internetMessageHeaders ?? []).map((h) => (h.name ?? "").toLowerCase()),
  );
  return {
    thread: item.conversationId ?? "",
    from: addr(item.from),
    to: (item.toRecipients ?? []).map(addr).filter((a) => a.length > 0),
    cc: (item.ccRecipients ?? []).map(addr).filter((a) => a.length > 0),
    unread: item.isRead === false,
    // A mechanical fact (the header is present), never a guess about the subject.
    bulk: headerNames.has("list-id") || headerNames.has("list-unsubscribe"),
  };
}

/** Graph returns local-time strings without an offset; treat them as UTC instants. */
function normalizeInstant(value: string | undefined): string {
  if (value === undefined || value === "") return new Date(0).toISOString();
  const withZone = /[Zz]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`;
  const parsed = new Date(withZone);
  return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString();
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

/** One resolved Graph account: its raw slice plus its parsed settings. */
interface MsGraphAccount extends AccountSlice {
  readonly settings: MsGraphAccountSettings;
}

/**
 * Build the credential precondition for the configured accounts (ADR-0007
 * any-of): the pass throws only when **no** account has a client secret, while an
 * individual tokenless account is left to the per-account skip below.
 */
function msGraphCredentials(accounts: readonly MsGraphAccount[]): CredentialRequirement {
  const secretNames = accounts.map((account) => accountSecretName(account, "clientSecret"));
  const single = accounts.length === 1 && !(accounts[0] as MsGraphAccount).declared;
  return {
    secretNames,
    missingMessage: single
      ? MS_GRAPH_CREDENTIALS.missingMessage
      : `ms-graph connector: no clientSecret configured for any account ` +
        `(${accounts.map((a) => `'${a.name}'`).join(", ")}) — store each account's secret under ` +
        `keychain account 'connector:ms-graph:<account>:clientSecret', or set ` +
        `SUASOR_CONNECTOR_MS_GRAPH_<ACCOUNT>_CLIENTSECRET`,
  };
}

/** Microsoft Graph connector implementing the read-only contract (ADR-0007). */
class MsGraphConnector implements Connector {
  readonly name = MS_GRAPH_CONNECTOR_NAME;
  readonly sourceType = "ms365";
  readonly credentials: CredentialRequirement;

  /** Per-account isolation outcome (set when `sync` ran) → finalize summary. */
  private accountIsolation: AccountIsolationResult | null = null;
  /** Per-account resource-isolation summary lines, in run order. */
  private resourceSummaries: string[] = [];
  /** Whether any account saw a partial per-resource failure. */
  private resourcePartial = false;

  constructor(
    private readonly accounts: readonly MsGraphAccount[],
    private readonly clientFactory: MsGraphClientFactory,
  ) {
    this.credentials = msGraphCredentials(accounts);
  }

  async *sync(ctx: SyncContext): AsyncIterable<SourceRecord> {
    // Empty scope is a genuine no-op: the credential precondition (`credentials`
    // above) is enforced centrally by the sync service before `sync()` runs, so
    // this early return can never mask a missing clientSecret (ADR-0007
    // "credential 解決は scope-emptiness 判定に先行する", Issue #440). Per account
    // (ADR-0050): an account that ingests nothing is dropped from the pass.
    const active = this.accounts.filter((account) => account.settings.resources.length > 0);
    if (active.length === 0) return;

    this.accountIsolation = null;
    this.resourceSummaries = [];
    this.resourcePartial = false;
    const secrets = new Map<string, string>();

    yield* syncAccountsIsolated(
      active,
      ctx,
      async (account) => {
        const clientSecret = await ctx.secret(accountSecretName(account, "clientSecret"));
        // A secretless account is skipped with a warning, never a total failure
        // (ADR-0007 multi-account clause).
        if (clientSecret === null) return "no clientSecret configured";
        secrets.set(account.name, clientSecret);
        return null;
      },
      (account, accountCtx) =>
        this.syncAccount(account, secrets.get(account.name) as string, accountCtx),
      (result) => {
        this.accountIsolation = result;
      },
    );
  }

  /** Stream one account's configured resources, with per-resource isolation. */
  private async *syncAccount(
    account: MsGraphAccount,
    clientSecret: string,
    ctx: SyncContext,
  ): AsyncIterable<SourceRecord> {
    const { tenantId, clientId, user } = account.settings;
    // `user` joins the guard (ADR-0051): every request path is `/users/{user}/…`,
    // so an empty value would build `/users//messages` and fail deep inside the
    // SDK with a shape nobody can act on. Failing here names the missing key —
    // and it is a *config* failure, so it must not be reported as "Graph is
    // down" (ADR-0007 "no silent wrong answer" has a loud counterpart: no
    // misattributed one either).
    const missing = [
      ...(tenantId ? [] : ["tenantId"]),
      ...(clientId ? [] : ["clientId"]),
      ...(user ? [] : ["user"]),
    ];
    if (missing.length > 0) {
      // Account-scoped so the message names which account is unaddressable —
      // with several accounts, "required in config" alone is not actionable.
      const keys =
        missing.length === 1
          ? (missing[0] as string)
          : `${missing.slice(0, -1).join(", ")} and ${missing.at(-1)}`;
      const verb = missing.length === 1 ? "is" : "are";
      const hint =
        user.length === 0
          ? " ('user' is the mailbox to read — a UPN or object id; app-only credentials have " +
            "no signed-in user, so there is no 'me' to fall back to)"
          : "";
      throw new Error(
        account.declared
          ? `ms-graph connector: ${keys} ${verb} required in config (account '${account.name}')${hint}`
          : `ms-graph connector: ${keys} ${verb} required in config${hint}`,
      );
    }

    const client = await this.clientFactory({ tenantId, clientId, clientSecret, user });

    // Per-resource error isolation (ADR-0014 generalized, Issue #193): one
    // resource family failing (e.g. mail 403) records a warn and is skipped
    // while the rest stream; only an all-resources failure throws — which the
    // account layer above then isolates to this account (ADR-0050).
    const fetchResource = (resource: MsGraphResource): AsyncIterable<SourceRecord> =>
      (async function* () {
        let path: string | undefined = RESOURCE_SPEC[resource].path(user);
        while (path) {
          const page: GraphPage = await client.getPage(path);
          for (const item of page.value ?? []) {
            yield toRecord(resource, item, client, account);
          }
          path = page["@odata.nextLink"];
        }
      })();

    yield* syncResourcesIsolated(
      account.settings.resources,
      ctx,
      (resource) => resource,
      "resource",
      fetchResource,
      (result) => {
        if (result.partialFailure) this.resourcePartial = true;
        for (const line of result.summaryLines ?? []) {
          this.resourceSummaries.push(
            account.declared ? `account '${account.name}' ${line}` : line,
          );
        }
      },
    );
  }

  finalize(): SyncResult {
    // Fingerprint-based change detection; no per-run cursor to persist. A
    // partial failure — at either layer, a degraded account or a failed resource
    // family — is surfaced so the CLI exits non-zero without discarding the
    // collected records (ADR-0027, Issue #193 / ADR-0050).
    const partial = (this.accountIsolation?.partialFailure ?? false) || this.resourcePartial;
    if (!partial) return { cursor: null };
    const summaryLines = [
      ...(this.accountIsolation?.summaryLines ?? []),
      ...this.resourceSummaries,
    ];
    return {
      cursor: null,
      partialFailure: true,
      ...(summaryLines.length > 0 ? { summaryLines } : {}),
    };
  }
}

/**
 * Build the Microsoft Graph connector from its config slice (validates with Zod).
 * The Graph + MSAL SDKs are not imported here — only when `sync` actually runs.
 *
 * The slice is resolved into one account per `[connectors.ms-graph.accounts.<x>]`
 * entry — or the single implicit `default` account when there is no table
 * (ADR-0050) — each inheriting the flat keys it does not override.
 */
export function createMsGraphConnector(
  config: ConnectorConfig,
  options: MsGraphConnectorOptions = {},
): Connector {
  // Validate the whole slice first (account names, env-override collisions,
  // per-account typos) so those errors surface here and not as a confusing
  // failure inside one account's settings. The result is deliberately
  // discarded: Zod fills schema defaults into every account, which erases the
  // absent-vs-set distinction inheritance needs, so the effective config comes
  // from the raw merge in `accountSlices` (see multi-account.ts).
  MsGraphConnectorConfig.parse(config ?? {});
  const accounts: MsGraphAccount[] = accountSlices(config ?? {}).map((account) => ({
    ...account,
    settings: MsGraphAccountSettings.parse(account.slice),
  }));
  return new MsGraphConnector(accounts, options.clientFactory ?? defaultMsGraphClientFactory);
}

/** Platform manifest (SSOT for the scattered per-connector tables, Issue #440). */
export const manifest: ConnectorManifest = {
  name: MS_GRAPH_CONNECTOR_NAME,
  sourceType: "ms365",
  configSchema: MsGraphConnectorConfig,
  secretNames: MS_GRAPH_CREDENTIALS.secretNames,
  needsAuth: true,
  bundledInBinary: false,
  sliceTemplate: {
    body: [
      "enabled = true",
      '# tenantId = "<tenant-guid>"   # required for auth',
      '# clientId = "<app-client-id>" # required for auth',
      '# user = "someone@contoso.com" # required: whose mailbox / drive to read (UPN or object id)',
      "# A second tenant / mailbox goes in its own table:",
      "#   [connectors.ms-graph.accounts.work]  # see docs/guide/connectors.md (ADR-0050)",
      "#   `suasor onboard --connector ms-graph --account work` writes it for you",
    ],
  },
  requiredSettings: [
    { key: "tenantId", hint: "Azure AD tenant / directory id" },
    { key: "clientId", hint: "app registration (client) id" },
    // ADR-0051: every Graph path this connector reads is `/users/{user}/…`, and
    // the app-only flow has no signed-in user to resolve a `me`, so the mailbox
    // has to be named. This is the key whose old `"me"` default made an
    // unconfigured install fail as a 404 per resource instead of as a config
    // error, which is why it is declared here rather than left to the schema.
    {
      key: "user",
      hint: "user principal name or object id whose mailbox / calendar / drive is read",
    },
  ],
  noopWarning(slice) {
    const cfg = MsGraphConnectorConfig.parse(slice ?? {});
    if (cfg.resources.length === 0) {
      return "resources unset — nothing to ingest (set resources in config)";
    }
    return null;
  },
  genericAuth: true,
  // No id-discovery seam: Graph resources are named by fixed family
  // (mail / calendar / files / teams), not enumerated ids, so there is no
  // `ms-graph <verb>` discovery command in DISCOVERY_SPECS.
  genericDiscovery: false,
  surfacesChannels: false,
  surfacesTeams: false,
  // More than one tenant / mailbox in one install (ADR-0050): the ingest scope
  // is account-relative (`user = "someone@contoso.com"` names a user *inside a
  // tenant*), so the account has to be named.
  multiAccount: true,
  capabilityNotes: {
    genericDiscovery:
      "resources are a fixed family (mail/calendar/files/teams), not enumerated ids — no discovery verb",
  },
};
