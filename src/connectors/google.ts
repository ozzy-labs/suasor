/**
 * Google connector (ADR-0007). Read-only ingest across Google Workspace — Drive
 * files, Gmail messages, and Calendar events — into `SourceRecord`s.
 *
 * - **read-only** — only Google `list`/`get`/`export` read endpoints are called;
 *   nothing is written back (ADR-0003). Drive content downloads for extraction
 *   are a read-only fetch (bytes flow "external → here", never "here →
 *   external"; ADR-0034 §d).
 * - **delta** — collections are paged via `nextPageToken`. The connector walks
 *   every page each run and relies on the body fingerprint (sync service SHA-256)
 *   for change detection (FR-ING-3); `finalize` returns `cursor: null`. Drive
 *   files supply a **content** fingerprint so a content-only change re-extracts
 *   (ADR-0034 §b): binary files use Drive's `md5Checksum`; Google-native files
 *   (Docs/Sheets/Slides) have no md5, so the monotonic `version` is used instead.
 * - **identity** — `google:<resource>:<id>` (cross-source-unique, resource-
 *   prefixed, ADR-0007), or `google:<account>:<resource>:<id>` for a named
 *   account (ADR-0050). Calendar events additionally carry the calendar id
 *   (`google:calendar:<calendarId>:<eventId>`) **when more than one calendar is
 *   configured** (ADR-0051): one meeting has the same event id in every calendar
 *   it appears on, so two configured calendars would otherwise fight over a
 *   single source. `source_type` is one of `google_drive`, `gmail_message`,
 *   `google_calendar`.
 * - **multi-account** — `[connectors.google.accounts.<account>]` ingests a
 *   personal and a work Google account in one pass (ADR-0050), each with its own
 *   credential (`connector:google:<account>:refreshToken`), its own
 *   `calendarIds` / `resources`, and per-account error isolation. A config with no
 *   `accounts` table is exactly one unprefixed `default` account — the
 *   pre-ADR-0050 behaviour, byte for byte.
 * - **extraction** — Drive Office/PDF files carry an `extractable` handle so the
 *   shared sync extraction stage (ADR-0024) fetches their content via the Drive
 *   API and replaces the body with sidecar-extracted text. Google-native files
 *   are **exported** to the matching Office format (Docs→docx, Sheets→xlsx,
 *   Slides→pptx) inside `readBytes`, so the sidecar dispatch (by extension) is
 *   unchanged (ADR-0034 §c). Best-effort: a download/export/sidecar failure
 *   degrades back to name-only and ingest still succeeds (ADR-0034 §e). Non-Drive
 *   resources (Gmail/Calendar) carry no `extractable` handle.
 * - **import-clean** — `googleapis` is **lazy-imported inside `sync`**, so
 *   building the connector / registry never pulls the SDK (ADR-0007, NFR-PRF-1).
 *   Top-level imports are limited to `zod` + the contract + the extraction
 *   extension set (a pure `Set`, no SDK).
 * - **secrets** — the OAuth refresh token comes from `ctx.secret("refreshToken")`
 *   (keychain + env override, NFR-PRV-4); client id/secret live in config.
 */
import { extname } from "node:path";
import { z } from "zod";
import { ConfigError } from "../config/error.ts";
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

/** Google resource families this connector can ingest. */
export const GoogleResource = z.enum(["drive", "gmail", "calendar"]);
export type GoogleResource = z.infer<typeof GoogleResource>;

/**
 * Settings for **one** Google account. Every key here is per-account: a work and
 * a personal account differ in which calendar is `primary`, which resources are
 * worth ingesting, and which addresses count as "me" (ADR-0050).
 */
const GoogleAccountSettings = z.object({
  /** OAuth client id of the desktop / web app. */
  clientId: z.string().min(1).default(""),
  /**
   * Calendar ids to read events from (ADR-0051). A list, not a single id: one
   * Google account routinely owns several calendars that matter (your own plus a
   * team / project calendar you were added to), and the previous single
   * `calendarId` made every one of them but the chosen one unreachable — with no
   * way to say so, because "the calendars I ingest" was not a set.
   *
   * Defaults to the account's primary calendar, i.e. the previous default.
   * Explicitly `[]` means "no calendar events", which the manifest's
   * {@link ConnectorManifest.noopWarning} reports when `calendar` is in
   * `resources` (a silent 0-event ingest is the ADR-0007 failure).
   */
  calendarIds: z.array(z.string().min(1)).default(["primary"]),
  /** Resource families to ingest. */
  resources: z.array(GoogleResource).default(["drive", "gmail", "calendar"]),
  /**
   * The operator's own email addresses (ADR-0043 決定 2), lowercased on read.
   * Email demand — "addressed to me and still unanswered" — cannot be derived
   * without knowing who "me" is, so an empty list means **no email demand at
   * all** (the same shape as Slack's `self_user_ids`).
   *
   * Not auto-derived from the API on purpose: aliases, former addresses and
   * distribution lists (`team@`) are all legitimately "me", and the single
   * primary address a profile call returns would silently miss them.
   */
  self_addresses: z.array(z.string().min(1)).default([]),
});
export type GoogleAccountSettings = z.infer<typeof GoogleAccountSettings>;

/**
 * `[connectors.google]` config (docs/design/config.md). The flat keys configure
 * the single `default` account **and** act as inherited defaults for every entry
 * of the optional `[connectors.google.accounts.<account>]` table (ADR-0050) — one
 * OAuth `clientId` typically serves every account the operator owns.
 */
export const GoogleConnectorConfig = GoogleAccountSettings.extend({
  accounts: accountsRecord(GoogleAccountSettings.partial().strict()),
});
export type GoogleConnectorConfig = z.infer<typeof GoogleConnectorConfig>;

export const GOOGLE_CONNECTOR_NAME = "google";

/** The removed single-calendar key, replaced by `calendarIds` (ADR-0051). */
const LEGACY_CALENDAR_KEY = "calendarId";

/** Whether a value is a plain object (a TOML table). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Config paths still carrying the removed `calendarId` key: the flat slice and
 * every `accounts.<account>` table (both spellings exist in the wild since
 * ADR-0050).
 */
function legacyCalendarPaths(config: ConnectorConfig): { path: string; value: unknown }[] {
  const raw = isRecord(config) ? config : {};
  const found: { path: string; value: unknown }[] = [];
  if (raw[LEGACY_CALENDAR_KEY] !== undefined) {
    found.push({ path: `[connectors.google]`, value: raw[LEGACY_CALENDAR_KEY] });
  }
  const accounts = raw.accounts;
  if (isRecord(accounts)) {
    for (const name of Object.keys(accounts).sort()) {
      const table = accounts[name];
      if (isRecord(table) && table[LEGACY_CALENDAR_KEY] !== undefined) {
        found.push({
          path: `[connectors.google.accounts.${name}]`,
          value: table[LEGACY_CALENDAR_KEY],
        });
      }
    }
  }
  return found;
}

/**
 * Fail fast when the config slice still uses the removed singular `calendarId`
 * (ADR-0051), naming the exact `calendarIds` line to write in its place.
 *
 * Deliberately **not** an implicit `calendarId` → `calendarIds` promotion. The
 * two keys would then coexist with an unstated precedence (which wins if both are
 * set? does a flat `calendarId` still inherit into an account that sets
 * `calendarIds`?), and every answer to that makes an existing config mean
 * something the operator never wrote — the one outcome this migration must not
 * have. A one-line mechanical edit, surfaced at load, is cheaper than a silent
 * reinterpretation (same call as ADR-0042 決定 9 for Slack's removed shape).
 */
export function rejectLegacyGoogleConfig(config: ConnectorConfig): void {
  const found = legacyCalendarPaths(config);
  if (found.length === 0) return;
  throw new ConfigError("legacy google calendarId config (replaced by ADR-0051)", [
    `connectors.google: '${LEGACY_CALENDAR_KEY}' was replaced by the plural 'calendarIds' — ` +
      found
        .map(({ path, value }) => {
          const id = typeof value === "string" && value.length > 0 ? value : "primary";
          return `in ${path} write calendarIds = ["${id}"]`;
        })
        .join("; ") +
      `. Listing more than one id ingests every calendar in the list; ` +
      `run \`suasor google calendars\` to enumerate the visible ones. ` +
      `See docs/adr/0051-ingest-scope-defaults.md.`,
  ]);
}

/**
 * The operator's own addresses from a connector slice, lowercased and
 * de-duplicated (ADR-0043 決定 2). Mirrors `resolveSelfUserIds` for Slack.
 *
 * The union is taken **across accounts** (ADR-0050): "me" is one person with two
 * mailboxes, so a thread addressed to the work address is the operator's demand
 * regardless of which account ingested it. Reading only the flat key would have
 * made every named account's addresses invisible to the email-demand predicate —
 * i.e. silently empty demand, the exact failure `doctor` warns about for an
 * unset `self_addresses`.
 */
export function resolveSelfAddresses(config: ConnectorConfig): string[] {
  const addresses: string[] = [];
  for (const account of accountSlices(config)) {
    const raw = (account.slice as { self_addresses?: unknown }).self_addresses;
    if (!Array.isArray(raw)) continue;
    for (const value of raw) {
      const address = String(value).trim().toLowerCase();
      if (address.length > 0) addresses.push(address);
    }
  }
  return [...new Set(addresses)];
}

/** Milliseconds in a day — the calendar window is expressed in days. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Rolling calendar ingest window (ADR-0044 決定 1). Past covers follow-up
 * ("what did we decide last month"); future covers preparation. Occurrences
 * outside it are simply not fetched — already-ingested rows stay.
 */
export const CALENDAR_WINDOW_PAST_DAYS = 30;
export const CALENDAR_WINDOW_FUTURE_DAYS = 90;

/**
 * Normalize a Google date/dateTime to an ISO instant. All-day events carry a
 * bare `YYYY-MM-DD`, which is widened to midnight UTC so every stored start is
 * comparable with a single string comparison.
 */
function normalizeInstant(value: string | null | undefined): string {
  if (value == null || value === "") return new Date(0).toISOString();
  return value.length === 10 ? `${value}T00:00:00.000Z` : new Date(value).toISOString();
}

/** Credential precondition enforced centrally by the sync service (Issue #440). */
const GOOGLE_CREDENTIALS: CredentialRequirement = {
  secretNames: ["refreshToken"],
  missingMessage:
    "google connector: no refreshToken configured " +
    "(set SUASOR_CONNECTOR_GOOGLE_REFRESHTOKEN or store it in the OS keychain)",
};

/**
 * Event facts a calendar item carries, in connector-neutral form (ADR-0044
 * 決定 1). `start` / `end` are the event's own times — deliberately separate
 * from `observedAt`, which stays "when this was last modified": conflating the
 * two is what made `meeting-prep` filter next week's meetings by *modification*
 * time, so a meeting booked three months ago for tomorrow fell outside the
 * window while one renamed yesterday came in.
 */
export interface CalendarMeta {
  /** Event start (ISO 8601, UTC-normalized). */
  start: string;
  /** Event end (ISO 8601, UTC-normalized). */
  end: string;
  /** Whether this is an all-day event (excluded from proximity). */
  allDay: boolean;
  /** The operator's role: organizer / required / optional / none. */
  role: "organizer" | "required" | "optional" | "none";
  /** The operator's RSVP: accepted / declined / tentative / none. */
  response: "accepted" | "declined" | "tentative" | "none";
  /** Attendee count only — never the addresses (ADR-0003 minimization). */
  attendees: number;
  /** Whether the event body carries an agenda. */
  hasAgenda: boolean;
  /** Whether the event has attachments. */
  hasAttachments: boolean;
  /** Whether this is an occurrence of a recurring series. */
  recurring: boolean;
}

/**
 * Mail facts, in connector-neutral form (ADR-0043 決定 1) — identical key names
 * across Gmail and Graph so the demand derivation needs one SQL branch.
 *
 * Addresses are lowercased at ingest so comparison never needs `LOWER()` at
 * query time. `bulk` is a *mechanical* fact (a List-Id / List-Unsubscribe
 * header), deliberately not a heuristic over subjects: newsletters routinely
 * address you in To, and letting them into the demand tier would recreate the
 * "pile of unprocessed" that ADR-0041 removed.
 */
export interface MailMeta {
  /** Thread id (`threadId` / `conversationId`) — demand is per thread. */
  thread: string;
  /** Sender address, lowercased. */
  from: string;
  /** To recipients, lowercased. */
  to: string[];
  /** Cc recipients, lowercased. */
  cc: string[];
  /** Whether the message is unread (auxiliary; never the demand predicate). */
  unread: boolean;
  /** Whether the message carries list headers (newsletter / automated). */
  bulk: boolean;
}

/** Extract the bare address from a header value like `Name <a@b.com>`. */
export function parseAddress(value: string): string {
  const angled = /<([^>]+)>/.exec(value);
  return (angled?.[1] ?? value).trim().toLowerCase();
}

/** Split a To/Cc header into lowercased bare addresses. */
export function parseAddressList(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") return [];
  return value
    .split(",")
    .map((part) => parseAddress(part))
    .filter((a) => a.length > 0);
}

/** A normalized Google item the connector maps into a record. */
export interface GoogleItem {
  id: string;
  /** Short title (file name, mail subject, event summary). */
  title: string;
  /** Body / snippet text held locally. */
  detail: string;
  /** Observation time (ISO 8601). */
  observedAt: string;
  /**
   * Calendar-only: the event's own times and the operator's relationship to it
   * (ADR-0044 決定 1). Kept under connector-neutral key names so the demand
   * derivation needs one SQL branch, not one per connector.
   */
  calendar?: CalendarMeta;
  /**
   * Mail-only: thread, participants and state, in connector-neutral form
   * (ADR-0043 決定 1). Gmail already fetches the full payload and discards
   * these headers, so this costs zero extra API calls.
   */
  mail?: MailMeta;
  /**
   * Drive file MIME type (Drive items only). Google-native types
   * (`application/vnd.google-apps.*`) are exported; everything else is downloaded
   * raw and dispatched by the filename extension. Absent for Gmail/Calendar.
   */
  mimeType?: string;
  /**
   * Drive file size in bytes (binary files only; drives the extraction size
   * guard, ADR-0034 §d/5). Google-native files report no size (their bytes are
   * synthesized on export) so this is absent for them.
   */
  size?: number;
  /**
   * Drive content fingerprint for binary files (Drive's `md5Checksum`). Drives
   * delta detection so a content-only change re-extracts (ADR-0034 §b). Absent
   * for native files (they expose no md5) — `version` covers those instead.
   */
  md5Checksum?: string;
  /**
   * Drive monotonic content+metadata `version`. Used as the fingerprint for
   * Google-native files (Docs/Sheets/Slides), which have no `md5Checksum`
   * (ADR-0034 §b). Absent for Gmail/Calendar.
   */
  version?: string;
}

/** One page of a Google resource listing. */
export interface GooglePage {
  items: GoogleItem[];
  nextPageToken?: string;
}

const SOURCE_TYPE: Record<GoogleResource, string> = {
  drive: "google_drive",
  gmail: "gmail_message",
  calendar: "google_calendar",
};

/**
 * Google-native (Drive editor) MIME types → the Office format the Drive `export`
 * endpoint converts them to, plus the synthetic filename extension the sidecar
 * dispatches on (ADR-0034 §c). Native files carry no real bytes, so we export
 * them to a binary the existing docx/xlsx/pptx extraction route already handles.
 */
const NATIVE_EXPORT: Record<string, { mimeType: string; ext: string }> = {
  "application/vnd.google-apps.document": {
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ext: ".docx",
  },
  "application/vnd.google-apps.spreadsheet": {
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ext: ".xlsx",
  },
  "application/vnd.google-apps.presentation": {
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ext: ".pptx",
  },
};

/** Whether a MIME type is a Google-native editor format (no real bytes). */
function isNativeMime(mimeType: string | undefined): boolean {
  return mimeType?.startsWith("application/vnd.google-apps.") ?? false;
}

/**
 * Resolve a Drive item's extraction handle, or `undefined` when it is not
 * extractable. Two routes (ADR-0034 §c):
 *
 * - **Google-native** (Docs/Sheets/Slides): exported to the matching Office
 *   format in `readBytes`. The synthetic filename (real name + `.docx`/`.xlsx`/
 *   `.pptx`) is what the sidecar dispatches on. Native files report no size, so
 *   the size guard cannot pre-screen them — `byteSize: 0` lets the extraction
 *   stage proceed (the extracted-text cap still applies). Unmapped native types
 *   (e.g. Forms) have no export target → name-only.
 * - **binary** (uploaded docx/xlsx/pptx/pdf): downloaded raw via the Drive media
 *   endpoint, dispatched by the real extension. Requires a reported `size` so the
 *   size guard can skip oversized inputs before the download (mirrors box).
 */
function driveExtractable(item: GoogleItem, client: GoogleClientLike): SourceRecord["extractable"] {
  if (isNativeMime(item.mimeType)) {
    const target = NATIVE_EXPORT[item.mimeType as string];
    if (!target) return undefined; // unmapped native (Forms, etc.) → name-only
    return {
      filename: `${item.title}${target.ext}`,
      byteSize: 0, // native bytes are synthesized on export; no pre-download size
      readBytes: (): Promise<Uint8Array> => client.exportFile(item.id, target.mimeType),
    };
  }
  const ext = extname(item.title).toLowerCase();
  if (!EXTRACTABLE_EXTENSIONS.has(ext) || item.size === undefined) return undefined;
  return {
    filename: item.title,
    byteSize: item.size,
    readBytes: (): Promise<Uint8Array> => client.downloadFile(item.id),
  };
}

/**
 * Build a `SourceRecord` for one Google item of a resource family.
 *
 * Drive files attach a content fingerprint (binary: `md5Checksum`; native:
 * `version`) so a content-only change re-extracts (ADR-0034 §b), and — for
 * extractable formats — an `extractable` handle whose `readBytes` lazily fetches
 * the content via the Drive API (download for binaries, export for native).
 * `readBytes` is only called when the sync extraction stage actually runs, so
 * unchanged records and non-extractable files pay no download cost. Gmail and
 * Calendar items stay body-only (no fingerprint/extractable).
 */
function toRecord(
  resource: GoogleResource,
  item: GoogleItem,
  client: GoogleClientLike,
  account: AccountSlice,
  calendarId: string | null,
): SourceRecord {
  const body =
    item.title && item.detail ? `${item.title}\n\n${item.detail}` : item.title || item.detail;
  const isDrive = resource === "drive";
  const fingerprint = isDrive ? (item.md5Checksum ?? item.version) : undefined;
  const extractable = isDrive ? driveExtractable(item, client) : undefined;
  return {
    // Named accounts namespace the id (ADR-0050): Gmail message ids are unique
    // per mailbox and one meeting carries the same Calendar event id in every
    // attendee's copy, so two accounts would otherwise write one flip-flopping
    // source. `default` stays unprefixed so an existing install's lineage holds.
    // The same argument applies *within* one account once several calendars are
    // configured (ADR-0051), and `calendarId` is non-null exactly then — a single
    // configured calendar keeps the pre-ADR-0051 id.
    externalId:
      `google:${accountIdPrefix(account)}${resource}:` +
      `${calendarId === null ? "" : `${calendarId}:`}${item.id}`,
    sourceType: SOURCE_TYPE[resource],
    body,
    observedAt: item.observedAt,
    meta: {
      resource,
      id: item.id,
      // Only for an explicitly declared account: a single-account install keeps
      // exactly the meta it already has (no rewrite of existing rows).
      ...(account.declared ? { account: account.name } : {}),
      // Likewise only in multi-calendar mode, where the id is namespaced anyway
      // so every such record is new and carries this from creation.
      ...(calendarId === null ? {} : { calendarId }),
      ...(item.calendar !== undefined ? item.calendar : {}),
      ...(item.mail !== undefined ? item.mail : {}),
    },
    ...(fingerprint ? { fingerprint } : {}),
    ...(extractable !== undefined ? { extractable } : {}),
  };
}

/**
 * The Google client surface we depend on: list one page of a resource family,
 * and (for Drive extraction) download a binary file's bytes or export a native
 * file to an Office format. Declared structurally (already normalized to
 * `GoogleItem`) so tests inject a fake without the SDK and so the real client is
 * lazy-loaded.
 */
export interface GoogleClientLike {
  /**
   * List one page of a resource family. `calendarId` names which calendar to
   * read and is supplied **only** for `resource === "calendar"` (ADR-0051): the
   * connector walks each configured calendar separately, so the id is a
   * per-call argument rather than client state.
   */
  listPage(resource: GoogleResource, pageToken?: string, calendarId?: string): Promise<GooglePage>;
  /** Download one binary Drive file's raw bytes (read-only, ADR-0034 §d). */
  downloadFile(fileId: string): Promise<Uint8Array>;
  /** Export one Google-native Drive file to `mimeType` (Office) bytes (read-only). */
  exportFile(fileId: string, mimeType: string): Promise<Uint8Array>;
}

/** How the connector obtains a Google client (overridable in tests). */
export type GoogleClientFactory = (auth: {
  clientId: string;
  refreshToken: string;
}) => Promise<GoogleClientLike> | GoogleClientLike;

/**
 * Default factory: lazy-imports `googleapis`, building an OAuth2 client from the
 * refresh token and normalizing each resource's listing into `GoogleItem`s. Kept
 * out of the top level so registration stays import-clean (ADR-0007).
 */
const defaultGoogleClientFactory: GoogleClientFactory = async ({ clientId, refreshToken }) => {
  const { google } = await import("googleapis");
  const auth = new google.auth.OAuth2({ clientId });
  auth.setCredentials({ refresh_token: refreshToken });
  const drive = google.drive({ version: "v3", auth });
  const gmail = google.gmail({ version: "v1", auth });
  const calendar = google.calendar({ version: "v3", auth });

  return {
    async listPage(resource, pageToken, calendarId) {
      if (resource === "drive") {
        const res = await drive.files.list({
          pageSize: 50,
          // `mimeType` drives the native-export vs. raw-download choice; `size` +
          // `md5Checksum` + `version` feed the size guard and content fingerprint
          // (ADR-0034 §b/§d) on top of the name-only ingest.
          fields:
            "nextPageToken, files(id, name, modifiedTime, description, mimeType, size, md5Checksum, version)",
          ...(pageToken ? { pageToken } : {}),
        });
        const items: GoogleItem[] = (res.data.files ?? []).map((f) => ({
          id: f.id ?? "",
          title: f.name ?? "",
          detail: f.description ?? "",
          observedAt: f.modifiedTime ?? new Date(0).toISOString(),
          ...(f.mimeType ? { mimeType: f.mimeType } : {}),
          // Drive returns `size` as a string; coerce to a number for the guard.
          ...(f.size != null ? { size: Number(f.size) } : {}),
          ...(f.md5Checksum ? { md5Checksum: f.md5Checksum } : {}),
          ...(f.version != null ? { version: String(f.version) } : {}),
        }));
        return { items, nextPageToken: res.data.nextPageToken ?? undefined };
      }
      if (resource === "gmail") {
        const list = await gmail.users.messages.list({
          userId: "me",
          maxResults: 50,
          ...(pageToken ? { pageToken } : {}),
        });
        const items: GoogleItem[] = [];
        for (const m of list.data.messages ?? []) {
          const full = await gmail.users.messages.get({ userId: "me", id: m.id ?? "" });
          const headers = full.data.payload?.headers ?? [];
          const header = (name: string) =>
            headers.find((h) => h.name?.toLowerCase() === name)?.value ?? undefined;
          const subject = header("subject") ?? "";
          const internal = Number(full.data.internalDate ?? 0);
          const labels = full.data.labelIds ?? [];
          items.push({
            id: m.id ?? "",
            title: subject,
            detail: full.data.snippet ?? "",
            observedAt: new Date(internal).toISOString(),
            // Already-fetched headers that used to be read and thrown away
            // (ADR-0043 決定 1) — zero additional requests.
            mail: {
              thread: full.data.threadId ?? "",
              from: parseAddress(header("from") ?? ""),
              to: parseAddressList(header("to")),
              cc: parseAddressList(header("cc")),
              unread: labels.includes("UNREAD"),
              bulk: header("list-id") !== undefined || header("list-unsubscribe") !== undefined,
            },
          });
        }
        return { items, nextPageToken: list.data.nextPageToken ?? undefined };
      }
      // calendar: a rolling window, expanded to occurrences (ADR-0044 決定 1).
      // Without timeMin/timeMax `singleEvents` expands the *entire* history of
      // every recurring series; the window bounds that to what a secretary can
      // act on (past for follow-up, future for prep).
      //
      // No `?? "primary"` fallback: the connector always names the calendar it
      // is walking (ADR-0051), and quietly reading a different calendar than the
      // one configured is exactly the silent wrong answer ADR-0007 forbids.
      if (calendarId === undefined) {
        throw new Error("google connector: listPage('calendar') requires a calendarId");
      }
      const now = Date.now();
      const res = await calendar.events.list({
        calendarId,
        maxResults: 50,
        singleEvents: true,
        timeMin: new Date(now - CALENDAR_WINDOW_PAST_DAYS * DAY_MS).toISOString(),
        timeMax: new Date(now + CALENDAR_WINDOW_FUTURE_DAYS * DAY_MS).toISOString(),
        ...(pageToken ? { pageToken } : {}),
      });
      const items: GoogleItem[] = (res.data.items ?? []).map((e) => {
        const self = (e.attendees ?? []).find((a) => a.self === true);
        const allDay = e.start?.date != null;
        return {
          id: e.id ?? "",
          title: e.summary ?? "",
          detail: e.description ?? "",
          // Modification time, not start time — the two are different questions
          // and sharing one column is what broke the "next week" filter.
          observedAt: e.updated ?? new Date(0).toISOString(),
          calendar: {
            start: normalizeInstant(e.start?.dateTime ?? e.start?.date),
            end: normalizeInstant(e.end?.dateTime ?? e.end?.date),
            allDay,
            role:
              e.organizer?.self === true
                ? "organizer"
                : self === undefined
                  ? "none"
                  : self.optional === true
                    ? "optional"
                    : "required",
            response:
              self?.responseStatus === "accepted"
                ? "accepted"
                : self?.responseStatus === "declined"
                  ? "declined"
                  : self?.responseStatus === "tentative"
                    ? "tentative"
                    : "none",
            attendees: (e.attendees ?? []).length,
            hasAgenda: (e.description ?? "").trim().length > 0,
            hasAttachments: (e.attachments ?? []).length > 0,
            recurring: e.recurringEventId != null,
          },
        };
      });
      return { items, nextPageToken: res.data.nextPageToken ?? undefined };
    },
    async downloadFile(fileId) {
      // Read-only binary fetch for extraction (ADR-0034 §d). `alt: "media"` streams
      // the raw bytes; request an arraybuffer so we get the content, not metadata.
      const res = await drive.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" });
      return new Uint8Array(res.data as ArrayBuffer);
    },
    async exportFile(fileId, mimeType) {
      // Read-only export of a Google-native file to an Office format (ADR-0034 §c).
      const res = await drive.files.export({ fileId, mimeType }, { responseType: "arraybuffer" });
      return new Uint8Array(res.data as ArrayBuffer);
    },
  };
};

export interface GoogleConnectorOptions {
  /** Google client factory override (tests inject a fake; default lazy-imports the SDK). */
  clientFactory?: GoogleClientFactory;
}

/** One resolved Google account: its raw slice plus its parsed settings. */
interface GoogleAccount extends AccountSlice {
  readonly settings: GoogleAccountSettings;
}

/**
 * One isolated unit of work inside an account: a resource family, and — for
 * `calendar` — which of the configured calendars this unit walks (ADR-0051).
 *
 * Expanding calendars into units rather than looping inside the `calendar` unit
 * is what keeps a single mistyped calendar id from taking every other calendar
 * down with it: the existing per-resource isolation (`per-resource.ts`) already
 * gives "one failed unit is warned and skipped, all-failed throws", and this
 * reuses it instead of growing a third isolation layer.
 */
export interface GoogleUnit {
  readonly resource: GoogleResource;
  /** Calendar to read (`calendar` units only; `null` for drive / gmail). */
  readonly fetchCalendarId: string | null;
  /**
   * Calendar id to namespace external ids and `meta` with, or `null` to keep the
   * pre-ADR-0051 unnamespaced form. Non-null **exactly** in multi-calendar mode
   * (see {@link toRecord}) — which is what makes a single-calendar install's
   * ingested lineage survive this change untouched.
   */
  readonly namespace: string | null;
  /** Isolation label: `calendar[<id>]` only in multi-calendar mode. */
  readonly label: string;
}

/**
 * Expand an account's `resources` into isolated units, splitting `calendar` into
 * one unit per configured calendar id.
 *
 * The single-calendar case is deliberately indistinguishable from the
 * pre-ADR-0051 shape — no namespace, label `calendar` — so existing installs keep
 * their external ids, their `meta` and their warning text unchanged. Duplicate
 * ids are collapsed: listing a calendar twice is a config typo, not a request to
 * ingest it twice.
 */
export function googleUnits(settings: GoogleAccountSettings): GoogleUnit[] {
  const units: GoogleUnit[] = [];
  for (const resource of settings.resources) {
    if (resource !== "calendar") {
      units.push({ resource, fetchCalendarId: null, namespace: null, label: resource });
      continue;
    }
    const ids = [...new Set(settings.calendarIds)];
    const multi = ids.length > 1;
    for (const id of ids) {
      units.push({
        resource,
        fetchCalendarId: id,
        namespace: multi ? id : null,
        label: multi ? `calendar[${id}]` : "calendar",
      });
    }
  }
  return units;
}

/**
 * Build the credential precondition for the configured accounts (ADR-0007
 * any-of): the pass throws only when **no** account has a token, while an
 * individual tokenless account is left to the per-account skip below.
 */
function googleCredentials(accounts: readonly GoogleAccount[]): CredentialRequirement {
  const secretNames = accounts.map((account) => accountSecretName(account, "refreshToken"));
  const single = accounts.length === 1 && !(accounts[0] as GoogleAccount).declared;
  return {
    secretNames,
    missingMessage: single
      ? GOOGLE_CREDENTIALS.missingMessage
      : `google connector: no refreshToken configured for any account ` +
        `(${accounts.map((a) => `'${a.name}'`).join(", ")}) — store each account's token under ` +
        `keychain account 'connector:google:<account>:refreshToken', or set ` +
        `SUASOR_CONNECTOR_GOOGLE_<ACCOUNT>_REFRESHTOKEN`,
  };
}

/** Google connector implementing the read-only contract (ADR-0007). */
class GoogleConnector implements Connector {
  readonly name = GOOGLE_CONNECTOR_NAME;
  readonly sourceType = "google";
  readonly credentials: CredentialRequirement;

  /** Per-account isolation outcome (set when `sync` ran) → finalize summary. */
  private accountIsolation: AccountIsolationResult | null = null;
  /** Per-account resource-isolation summary lines, in run order. */
  private resourceSummaries: string[] = [];
  /** Whether any account saw a partial per-resource failure. */
  private resourcePartial = false;

  constructor(
    private readonly accounts: readonly GoogleAccount[],
    private readonly clientFactory: GoogleClientFactory,
  ) {
    this.credentials = googleCredentials(accounts);
  }

  async *sync(ctx: SyncContext): AsyncIterable<SourceRecord> {
    // Empty scope is a genuine no-op: the credential precondition (`credentials`
    // above) is enforced centrally by the sync service before `sync()` runs, so
    // this early return can never mask a missing refreshToken (ADR-0007
    // "credential 解決は scope-emptiness 判定に先行する", Issue #440). Per account
    // (ADR-0050): an account that ingests nothing is dropped from the pass rather
    // than counted as a degraded one — it is a no-op, not a failure.
    const active = this.accounts.filter((account) => account.settings.resources.length > 0);
    if (active.length === 0) return;

    this.accountIsolation = null;
    this.resourceSummaries = [];
    this.resourcePartial = false;
    const tokens = new Map<string, string>();

    yield* syncAccountsIsolated(
      active,
      ctx,
      async (account) => {
        const refreshToken = await ctx.secret(accountSecretName(account, "refreshToken"));
        // A tokenless account is skipped with a warning, never a total failure
        // (ADR-0007 multi-account clause). The central check already guaranteed
        // at least one account has a credential.
        if (refreshToken === null) return "no refreshToken configured";
        tokens.set(account.name, refreshToken);
        return null;
      },
      (account, accountCtx) =>
        this.syncAccount(account, tokens.get(account.name) as string, accountCtx),
      (result) => {
        this.accountIsolation = result;
      },
    );
  }

  /** Stream one account's configured resources, with per-resource isolation. */
  private async *syncAccount(
    account: GoogleAccount,
    refreshToken: string,
    ctx: SyncContext,
  ): AsyncIterable<SourceRecord> {
    const client = await this.clientFactory({
      clientId: account.settings.clientId,
      refreshToken,
    });

    // Per-resource error isolation (ADR-0014 generalized, Issue #193): one
    // resource family failing (e.g. Drive 403) records a warn and is skipped
    // while the rest stream; only an all-resources failure throws — which the
    // account layer above then isolates to this account (ADR-0050). Calendars are
    // units of the same layer (ADR-0051), so one unreadable calendar does not
    // take the readable ones down with it.
    const fetchUnit = (unit: GoogleUnit): AsyncIterable<SourceRecord> =>
      (async function* () {
        let pageToken: string | undefined;
        do {
          const page = await client.listPage(
            unit.resource,
            pageToken,
            unit.fetchCalendarId ?? undefined,
          );
          for (const item of page.items) {
            yield toRecord(unit.resource, item, client, account, unit.namespace);
          }
          pageToken = page.nextPageToken;
        } while (pageToken);
      })();

    yield* syncResourcesIsolated(
      googleUnits(account.settings),
      ctx,
      (unit) => unit.label,
      "resource",
      fetchUnit,
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
 * Build the Google connector from its config slice (validates with Zod).
 * `googleapis` is not imported here — only when `sync` actually runs.
 *
 * The slice is resolved into one account per `[connectors.google.accounts.<x>]`
 * entry — or the single implicit `default` account when there is no table
 * (ADR-0050) — each inheriting the flat keys it does not override.
 */
export function createGoogleConnector(
  config: ConnectorConfig,
  options: GoogleConnectorOptions = {},
): Connector {
  // The removed singular `calendarId` gets the mechanical migration message
  // rather than a bare strict-mode "Unrecognized key" (ADR-0051; the same shape
  // ADR-0042 決定 9 gave Slack's removed multi-workspace keys).
  rejectLegacyGoogleConfig(config ?? {});
  // Validate the whole slice first (account names, env-override collisions,
  // per-account typos) so those errors surface here and not as a confusing
  // failure inside one account's settings. The result is deliberately
  // discarded: Zod fills schema defaults into every account, which erases the
  // absent-vs-set distinction inheritance needs, so the effective config comes
  // from the raw merge in `accountSlices` (see multi-account.ts).
  GoogleConnectorConfig.parse(config ?? {});
  const accounts: GoogleAccount[] = accountSlices(config ?? {}).map((account) => ({
    ...account,
    settings: GoogleAccountSettings.parse(account.slice),
  }));
  return new GoogleConnector(accounts, options.clientFactory ?? defaultGoogleClientFactory);
}

/** Platform manifest (SSOT for the scattered per-connector tables, Issue #440). */
export const manifest: ConnectorManifest = {
  name: GOOGLE_CONNECTOR_NAME,
  sourceType: "google",
  configSchema: GoogleConnectorConfig,
  secretNames: GOOGLE_CREDENTIALS.secretNames,
  needsAuth: true,
  bundledInBinary: false,
  sliceTemplate: {
    body: [
      "enabled = true",
      '# clientId = "<oauth-client-id>"  # required for auth',
      '# calendarIds = ["primary"]       # every calendar to ingest (`suasor google calendars`)',
      "# A second Google account (personal + work) goes in its own table:",
      "#   [connectors.google.accounts.work]   # see docs/guide/connectors.md (ADR-0050)",
    ],
  },
  requiredSettings: [{ key: "clientId", hint: "OAuth client id of the desktop / web app" }],
  noopWarning(slice) {
    const cfg = GoogleConnectorConfig.parse(slice ?? {});
    if (cfg.resources.length === 0) {
      return "resources unset — nothing to ingest (set resources in config)";
    }
    // A per-family no-op: the other families still ingest, so this is not the
    // whole-connector "nothing to ingest" case — but an emptied `calendarIds`
    // with `calendar` still in `resources` ingests zero events with no error at
    // all, which is the silent-0 failure this advisory exists for (ADR-0051).
    if (cfg.resources.includes("calendar") && cfg.calendarIds.length === 0) {
      return (
        "resources includes 'calendar' but calendarIds is empty — no calendar events " +
        'will be ingested (list the calendar ids, e.g. calendarIds = ["primary"])'
      );
    }
    return null;
  },
  genericAuth: true,
  genericDiscovery: true,
  surfacesChannels: false,
  surfacesTeams: false,
  // Personal + work Google accounts in one install (ADR-0050): the ingest scope
  // is account-relative (`calendarIds = ["primary"]`), so the account has to be
  // named.
  multiAccount: true,
};
