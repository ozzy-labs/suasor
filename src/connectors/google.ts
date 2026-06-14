/**
 * Google connector (ADR-0007). Read-only ingest across Google Workspace — Drive
 * files, Gmail messages, and Calendar events — into `SourceRecord`s.
 *
 * - **read-only** — only Google `list`/`get` read endpoints are called; nothing
 *   is written back (ADR-0003).
 * - **delta** — collections are paged via `nextPageToken`. The connector walks
 *   every page each run and relies on the body fingerprint (sync service SHA-256)
 *   for change detection (FR-ING-3); `finalize` returns `cursor: null`.
 * - **identity** — `google:<resource>:<id>` (cross-source-unique, resource-
 *   prefixed, ADR-0007). `source_type` is one of `google_drive`, `gmail_message`,
 *   `google_calendar`.
 * - **import-clean** — `googleapis` is **lazy-imported inside `sync`**, so
 *   building the connector / registry never pulls the SDK (ADR-0007, NFR-PRF-1).
 *   Top-level imports are limited to `zod` + the contract types.
 * - **secrets** — the OAuth refresh token comes from `ctx.secret("refreshToken")`
 *   (keychain + env override, NFR-PRV-4); client id/secret live in config.
 */
import { z } from "zod";
import type {
  Connector,
  ConnectorConfig,
  SourceRecord,
  SyncContext,
  SyncResult,
} from "./contract.ts";

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

/** Build a `SourceRecord` for one Google item of a resource family. */
function toRecord(resource: GoogleResource, item: GoogleItem): SourceRecord {
  const body =
    item.title && item.detail ? `${item.title}\n\n${item.detail}` : item.title || item.detail;
  return {
    externalId: `google:${resource}:${item.id}`,
    sourceType: SOURCE_TYPE[resource],
    body,
    observedAt: item.observedAt,
    meta: { resource, id: item.id },
  };
}

/**
 * The Google client surface we depend on: list one page of a resource family.
 * Declared structurally (already normalized to `GoogleItem`) so tests inject a
 * fake without the SDK and so the real client is lazy-loaded.
 */
export interface GoogleClientLike {
  listPage(resource: GoogleResource, pageToken?: string): Promise<GooglePage>;
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
          fields: "nextPageToken, files(id, name, modifiedTime, description)",
          ...(pageToken ? { pageToken } : {}),
        });
        const items: GoogleItem[] = (res.data.files ?? []).map((f) => ({
          id: f.id ?? "",
          title: f.name ?? "",
          detail: f.description ?? "",
          observedAt: f.modifiedTime ?? new Date(0).toISOString(),
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

    for (const resource of this.config.resources) {
      let pageToken: string | undefined;
      do {
        const page = await client.listPage(resource, pageToken);
        for (const item of page.items) {
          yield toRecord(resource, item);
        }
        pageToken = page.nextPageToken;
      } while (pageToken);
    }
  }

  finalize(): SyncResult {
    // Fingerprint-based change detection; no per-run cursor to persist.
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
