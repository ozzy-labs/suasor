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
 *   prefixed, ADR-0007). `source_type` is one of `google_drive`, `gmail_message`,
 *   `google_calendar`.
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
import { EXTRACTABLE_EXTENSIONS } from "../extraction/index.ts";
import type {
  Connector,
  ConnectorConfig,
  SourceRecord,
  SyncContext,
  SyncResult,
} from "./contract.ts";
import { type IsolationResult, syncResourcesIsolated } from "./per-resource.ts";

/** Google resource families this connector can ingest. */
export const GoogleResource = z.enum(["drive", "gmail", "calendar"]);
export type GoogleResource = z.infer<typeof GoogleResource>;

/** `[connectors.google]` config (docs/design/config.md). */
export const GoogleConnectorConfig = z.object({
  /** OAuth client id of the desktop / web app. */
  clientId: z.string().min(1).default(""),
  /** Calendar id to read events from (default the primary calendar). */
  calendarId: z.string().min(1).default("primary"),
  /** Resource families to ingest. */
  resources: z.array(GoogleResource).default(["drive", "gmail", "calendar"]),
});
export type GoogleConnectorConfig = z.infer<typeof GoogleConnectorConfig>;

export const GOOGLE_CONNECTOR_NAME = "google";

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
): SourceRecord {
  const body =
    item.title && item.detail ? `${item.title}\n\n${item.detail}` : item.title || item.detail;
  const isDrive = resource === "drive";
  const fingerprint = isDrive ? (item.md5Checksum ?? item.version) : undefined;
  const extractable = isDrive ? driveExtractable(item, client) : undefined;
  return {
    externalId: `google:${resource}:${item.id}`,
    sourceType: SOURCE_TYPE[resource],
    body,
    observedAt: item.observedAt,
    meta: { resource, id: item.id },
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
  listPage(resource: GoogleResource, pageToken?: string): Promise<GooglePage>;
  /** Download one binary Drive file's raw bytes (read-only, ADR-0034 §d). */
  downloadFile(fileId: string): Promise<Uint8Array>;
  /** Export one Google-native Drive file to `mimeType` (Office) bytes (read-only). */
  exportFile(fileId: string, mimeType: string): Promise<Uint8Array>;
}

/** How the connector obtains a Google client (overridable in tests). */
export type GoogleClientFactory = (auth: {
  clientId: string;
  refreshToken: string;
  calendarId: string;
}) => Promise<GoogleClientLike> | GoogleClientLike;

/**
 * Default factory: lazy-imports `googleapis`, building an OAuth2 client from the
 * refresh token and normalizing each resource's listing into `GoogleItem`s. Kept
 * out of the top level so registration stays import-clean (ADR-0007).
 */
const defaultGoogleClientFactory: GoogleClientFactory = async ({
  clientId,
  refreshToken,
  calendarId,
}) => {
  const { google } = await import("googleapis");
  const auth = new google.auth.OAuth2({ clientId });
  auth.setCredentials({ refresh_token: refreshToken });
  const drive = google.drive({ version: "v3", auth });
  const gmail = google.gmail({ version: "v1", auth });
  const calendar = google.calendar({ version: "v3", auth });

  return {
    async listPage(resource, pageToken) {
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
          const subject = headers.find((h) => h.name === "Subject")?.value ?? "";
          const internal = Number(full.data.internalDate ?? 0);
          items.push({
            id: m.id ?? "",
            title: subject,
            detail: full.data.snippet ?? "",
            observedAt: new Date(internal).toISOString(),
          });
        }
        return { items, nextPageToken: list.data.nextPageToken ?? undefined };
      }
      // calendar
      const res = await calendar.events.list({
        calendarId,
        maxResults: 50,
        singleEvents: true,
        ...(pageToken ? { pageToken } : {}),
      });
      const items: GoogleItem[] = (res.data.items ?? []).map((e) => ({
        id: e.id ?? "",
        title: e.summary ?? "",
        detail: e.description ?? "",
        observedAt: e.updated ?? e.start?.dateTime ?? e.start?.date ?? new Date(0).toISOString(),
      }));
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

/** Google connector implementing the read-only contract (ADR-0007). */
class GoogleConnector implements Connector {
  readonly name = GOOGLE_CONNECTOR_NAME;
  readonly sourceType = "google";

  /** Per-resource isolation outcome (set when `sync` ran) → finalize summary. */
  private isolation: IsolationResult | null = null;

  constructor(
    private readonly config: GoogleConnectorConfig,
    private readonly clientFactory: GoogleClientFactory,
  ) {}

  async *sync(ctx: SyncContext): AsyncIterable<SourceRecord> {
    if (this.config.resources.length === 0) return;

    const refreshToken = await ctx.secret("refreshToken");
    if (!refreshToken) {
      throw new Error(
        "google connector: no refreshToken configured " +
          "(set SUASOR_CONNECTOR_GOOGLE_REFRESHTOKEN or store it in the OS keychain)",
      );
    }

    const client = await this.clientFactory({
      clientId: this.config.clientId,
      refreshToken,
      calendarId: this.config.calendarId,
    });
    this.isolation = null;

    // Per-resource error isolation (ADR-0014 generalized, Issue #193): one
    // resource family failing (e.g. Drive 403) records a warn and is skipped
    // while the rest stream; only an all-resources failure throws.
    const fetchResource = (resource: GoogleResource): AsyncIterable<SourceRecord> =>
      (async function* () {
        let pageToken: string | undefined;
        do {
          const page = await client.listPage(resource, pageToken);
          for (const item of page.items) {
            yield toRecord(resource, item, client);
          }
          pageToken = page.nextPageToken;
        } while (pageToken);
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
 * Build the Google connector from its config slice (validates with Zod).
 * `googleapis` is not imported here — only when `sync` actually runs.
 */
export function createGoogleConnector(
  config: ConnectorConfig,
  options: GoogleConnectorOptions = {},
): Connector {
  const parsed = GoogleConnectorConfig.parse(config ?? {});
  return new GoogleConnector(parsed, options.clientFactory ?? defaultGoogleClientFactory);
}
