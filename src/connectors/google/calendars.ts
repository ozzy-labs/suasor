/**
 * Google calendar discovery for `google calendars` (ADR-0030; the google port of
 * Slack's `slack conversations` / github's `github repos` discovery).
 *
 * Enumerates the calendars a refresh token can see (`GET
 * /calendar/v3/users/me/calendarList`) so the operator can discover the
 * `calendarId` the connector reads without hand-hunting it from the Google
 * Calendar Web UI — closing the typo→silent-0-results gap (ADR-0007 "no silent
 * wrong answer"). Renders a paste-ready `[connectors.google]` block carrying the
 * discovered ids (the singular `calendarId` the connector config expects).
 *
 * Import-clean (ADR-0007): no `googleapis`. The default transport uses the
 * global `fetch` (same pattern as `src/connectors/google/auth.ts`), wrapped in the
 * shared {@link fetchWithRetry} so a transient 429/5xx (with `Retry-After`
 * honoured) is retried rather than aborting the sweep mid-pagination (Issue #269).
 * Building the connector / CLI registry never pulls the SDK. The refresh token /
 * client secret / access token are never echoed in thrown errors.
 *
 * The probe needs an **access token**, so it first exchanges the keychain
 * refresh token (`refreshToken`) + config `clientId` (+ optional keychain
 * `clientSecret` for installed/web clients) at Google's OAuth2 token endpoint —
 * the same exchange `google auth test` performs (`src/connectors/google/auth.ts`).
 */
import {
  DEFAULT_CONNECTOR_TIMEOUT_MS,
  type FetchWithRetryOptions,
  fetchWithRetry,
} from "../../util/retry.ts";

/** One calendar surfaced for the discovery CLI. */
export interface GoogleCalendar {
  /** Calendar id — the value `[connectors.google].calendarId` expects. */
  readonly id: string;
  /** Human-readable name (`summaryOverride` preferred, else `summary`). */
  readonly summary: string;
  /** IANA time zone of the calendar (e.g. `Asia/Tokyo`), or empty when absent. */
  readonly timeZone: string;
  /** Whether this is the user's primary calendar. */
  readonly primary: boolean;
  /** Access role the token holds (`owner` / `reader` / `writer` / …). */
  readonly accessRole: string;
}

/** Result of a discovery sweep: the visible calendars, sorted (primary first). */
export interface CalendarsResult {
  readonly calendars: GoogleCalendar[];
}

/** Inputs needed to mint an access token from the stored refresh token. */
export interface ListCalendarsAuth {
  readonly clientId: string;
  readonly refreshToken: string;
  /** Optional client secret (installed/web clients); omitted for public clients. */
  readonly clientSecret?: string;
}

export interface ListCalendarsOptions {
  /** Substring filter over id + summary (case-insensitive). */
  readonly filter?: string;
  /** Transport override (tests inject a fake; default lazy-`fetch`). */
  readonly transport?: GoogleCalendarsTransport;
  /**
   * Called once per network round-trip (token exchange + each calendarList page)
   * so a CLI can render an indeterminate progress counter while the sweep runs.
   * Best-effort: any throw is ignored so progress reporting never fails the listing.
   */
  readonly onProgress?: () => void;
}

/** A single HTTP round-trip, decoupled from `fetch` so tests inject a fake. */
export type GoogleCalendarsTransport = (request: {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  /** Form-encoded body for the token POST; absent for the calendarList GET. */
  body?: string;
}) => Promise<{ status: number; body: unknown }>;

/** Per-page ceiling (Google's max for `maxResults` on calendarList). */
const PAGE_LIMIT = 250;
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_LIST_URL = "https://www.googleapis.com/calendar/v3/users/me/calendarList";

/**
 * Build the default transport: a `fetch` round-trip (token POST + calendarList
 * GET) run through {@link fetchWithRetry} so a transient 429/5xx is retried rather
 * than aborting the sweep mid-pagination (Issue #269). `retry` is injectable
 * (`fetchImpl` / `sleep`) so a test can drive "429 → Retry-After → success" with
 * no real waiting.
 */
export function makeDefaultTransport(retry: FetchWithRetryOptions = {}): GoogleCalendarsTransport {
  // Default a per-attempt timeout so a hung host cannot pin a bulk-sync worker
  // (Issue #269); a caller-supplied `timeoutMs` still wins.
  const opts = { timeoutMs: DEFAULT_CONNECTOR_TIMEOUT_MS, ...retry };
  return async ({ method, url, headers, body }) => {
    const res = await fetchWithRetry(
      url,
      { method, headers, ...(body !== undefined ? { body } : {}) },
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

const defaultTransport: GoogleCalendarsTransport = makeDefaultTransport();

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

interface RawCalendar {
  id?: string;
  summary?: string;
  summaryOverride?: string;
  timeZone?: string;
  primary?: boolean;
  accessRole?: string;
}

function toCalendar(raw: RawCalendar): GoogleCalendar | null {
  if (typeof raw.id !== "string" || raw.id.length === 0) return null;
  return {
    id: raw.id,
    summary: asString(raw.summaryOverride) || asString(raw.summary),
    timeZone: asString(raw.timeZone),
    primary: raw.primary === true,
    accessRole: asString(raw.accessRole),
  };
}

/**
 * Exchange the refresh token for an access token at Google's OAuth2 endpoint.
 *
 * @throws {Error} when the exchange returns a non-2xx / no access token (message
 *   carries the `error` / `error_description`, never the secrets).
 */
async function mintAccessToken(
  auth: ListCalendarsAuth,
  transport: GoogleCalendarsTransport,
): Promise<string> {
  const form = new URLSearchParams({
    client_id: auth.clientId,
    refresh_token: auth.refreshToken,
    grant_type: "refresh_token",
  });
  if (auth.clientSecret) form.set("client_secret", auth.clientSecret);
  const { status, body } = await transport({
    method: "POST",
    url: TOKEN_URL,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const obj = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const accessToken = asString(obj.access_token);
  if (status < 200 || status >= 300 || accessToken.length === 0) {
    const detail =
      asString(obj.error_description) || asString(obj.error) || `HTTP ${status}` || "unknown error";
    throw new Error(`google token exchange failed: ${detail}`);
  }
  return accessToken;
}

/**
 * Enumerate the calendars a refresh token can see, following `nextPageToken`
 * pagination. Exchanges the refresh token for an access token first.
 *
 * @throws {Error} when the token exchange or `GET .../calendarList` returns a
 *   non-2xx (message carries the HTTP status + Google message, never any secret).
 */
export async function listCalendars(
  auth: ListCalendarsAuth,
  options: ListCalendarsOptions = {},
): Promise<CalendarsResult> {
  const transport = options.transport ?? defaultTransport;
  // Best-effort progress tick: a throw in the reporter must not fail the sweep.
  const tick = () => {
    try {
      options.onProgress?.();
    } catch {}
  };

  const accessToken = await mintAccessToken(auth, transport);
  tick();

  const calendars: GoogleCalendar[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ maxResults: String(PAGE_LIMIT) });
    if (pageToken) params.set("pageToken", pageToken);
    const { status, body } = await transport({
      method: "GET",
      url: `${CALENDAR_LIST_URL}?${params.toString()}`,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    tick();
    const obj = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    if (status < 200 || status >= 300) {
      const errObj =
        obj.error && typeof obj.error === "object" ? (obj.error as Record<string, unknown>) : {};
      const message = asString(errObj.message) || asString(obj.error) || "unknown error";
      throw new Error(`google GET /calendarList failed: ${status} ${message}`);
    }
    const items = Array.isArray(obj.items) ? (obj.items as RawCalendar[]) : [];
    for (const raw of items) {
      const calendar = toCalendar(raw);
      if (calendar) calendars.push(calendar);
    }
    pageToken = asString(obj.nextPageToken) || undefined;
  } while (pageToken);

  let filtered = calendars;
  if (options.filter !== undefined && options.filter.length > 0) {
    const needle = options.filter.toLowerCase();
    filtered = calendars.filter(
      (c) => c.id.toLowerCase().includes(needle) || c.summary.toLowerCase().includes(needle),
    );
  }

  // Primary calendar first, then a-z by summary (case-insensitive) for a stable,
  // scannable listing — the operator most often wants their primary calendar.
  filtered.sort((a, b) => {
    if (a.primary !== b.primary) return a.primary ? -1 : 1;
    return a.summary.localeCompare(b.summary, undefined, { sensitivity: "base" });
  });
  return { calendars: filtered };
}

/**
 * Render a `[connectors.google]` config block the operator can paste straight
 * into `config.toml`. Unlike github's plural `repos = [...]`, the google
 * connector reads a **single** `calendarId`, so the block sets `calendarId` to
 * the primary (or first) discovered calendar and lists every other visible
 * calendar id as a `#` comment the operator can swap in — a mistyped id silently
 * ingests nothing (the gap this closes, ADR-0030).
 */
export function renderConfigBlock(result: CalendarsResult): string[] {
  const lines = ["[connectors.google]", "enabled = true"];
  const chosen = result.calendars[0];
  if (!chosen) {
    lines.push('calendarId = "primary"');
    return lines;
  }
  const labelOf = (c: GoogleCalendar): string => {
    const parts = [c.summary || "(no summary)"];
    if (c.timeZone) parts.push(c.timeZone);
    if (c.primary) parts.push("primary");
    return parts.join(", ");
  };
  lines.push("# calendarId is a single calendar id — the # comment is just a label");
  lines.push(`calendarId = "${chosen.id}"  # ${labelOf(chosen)}`);
  for (const c of result.calendars.slice(1)) {
    lines.push(`# calendarId = "${c.id}"  # ${labelOf(c)}`);
  }
  return lines;
}
