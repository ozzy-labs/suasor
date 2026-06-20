/**
 * Google calendar discovery leaf (`google calendars`, ADR-0030). Exercises the
 * `fetch`-free path with an injected transport: refresh→access token exchange,
 * calendarList enumeration, nextPageToken pagination, summary/timeZone/primary
 * derivation, `--filter`, the paste-ready config block, and secret-safe errors.
 * No network, no SDK.
 */
import { describe, expect, test } from "bun:test";
import {
  type GoogleCalendarsTransport,
  listCalendars,
  renderConfigBlock,
} from "../../../src/connectors/google/calendars.ts";

const AUTH = { clientId: "client-x", refreshToken: "rt_secret" } as const;

/** A token-exchange response that mints `access`. */
function tokenOk(access = "at_x"): { status: number; body: unknown } {
  return { status: 200, body: { access_token: access, scope: "calendar", expires_in: 3600 } };
}

/**
 * Build a transport: the first request (POST token) returns `token`, subsequent
 * GETs serve the queued calendarList pages in order. Records every call.
 */
function fakeTransport(opts: {
  token?: { status: number; body: unknown };
  pages?: { status?: number; body: unknown }[];
}): {
  transport: GoogleCalendarsTransport;
  calls: { method: string; url: string; headers: Record<string, string>; body?: string }[];
} {
  const calls: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string;
  }[] = [];
  let pageIdx = 0;
  const transport: GoogleCalendarsTransport = async (req) => {
    calls.push(req);
    if (req.method === "POST") return opts.token ?? tokenOk();
    const page = opts.pages?.[Math.min(pageIdx, (opts.pages?.length ?? 1) - 1)];
    pageIdx += 1;
    return { status: page?.status ?? 200, body: page?.body ?? { items: [] } };
  };
  return { transport, calls };
}

describe("calendars — listCalendars", () => {
  test("exchanges the refresh token then enumerates, deriving fields", async () => {
    const { transport, calls } = fakeTransport({
      pages: [
        {
          body: {
            items: [
              { id: "work@x.com", summary: "Work", timeZone: "Asia/Tokyo", accessRole: "owner" },
              { id: "primary", summary: "Me", timeZone: "Asia/Tokyo", primary: true },
            ],
          },
        },
      ],
    });
    const { calendars } = await listCalendars(AUTH, { transport });
    // Primary sorts first, then a-z by summary.
    expect(calendars.map((c) => c.id)).toEqual(["primary", "work@x.com"]);
    const byId = Object.fromEntries(calendars.map((c) => [c.id, c]));
    expect(byId.primary?.primary).toBe(true);
    expect(byId["work@x.com"]?.timeZone).toBe("Asia/Tokyo");
    expect(byId["work@x.com"]?.accessRole).toBe("owner");

    // First call is the token POST; carries the refresh grant, never echoed back.
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("oauth2.googleapis.com/token");
    expect(calls[0]?.body).toContain("grant_type=refresh_token");
    // The calendarList GET carries the minted access token + maxResults.
    expect(calls[1]?.method).toBe("GET");
    expect(calls[1]?.url).toContain("/calendar/v3/users/me/calendarList");
    expect(calls[1]?.url).toContain("maxResults=250");
    expect(calls[1]?.headers.Authorization).toBe("Bearer at_x");
  });

  test("prefers summaryOverride over summary", async () => {
    const { transport } = fakeTransport({
      pages: [{ body: { items: [{ id: "c1", summary: "Real", summaryOverride: "Alias" }] } }],
    });
    const { calendars } = await listCalendars(AUTH, { transport });
    expect(calendars[0]?.summary).toBe("Alias");
  });

  test("follows nextPageToken across pages", async () => {
    const { transport, calls } = fakeTransport({
      pages: [
        { body: { items: [{ id: "a@x", summary: "A" }], nextPageToken: "p2" } },
        { body: { items: [{ id: "b@x", summary: "B" }] } },
      ],
    });
    const { calendars } = await listCalendars(AUTH, { transport });
    expect(calendars.map((c) => c.id)).toEqual(["a@x", "b@x"]);
    const gets = calls.filter((c) => c.method === "GET");
    expect(gets).toHaveLength(2);
    expect(gets[1]?.url).toContain("pageToken=p2");
  });

  test("--filter narrows by case-insensitive id or summary substring", async () => {
    const { transport } = fakeTransport({
      pages: [
        {
          body: {
            items: [
              { id: "work@x.com", summary: "Work" },
              { id: "home@x.com", summary: "Home" },
              { id: "team@acme.com", summary: "Acme Team" },
            ],
          },
        },
      ],
    });
    // Matches by summary ("acme") even though id also contains it.
    const { calendars } = await listCalendars(AUTH, { transport, filter: "ACME" });
    expect(calendars.map((c) => c.id)).toEqual(["team@acme.com"]);
  });

  test("throws with status + message (never a secret) on a non-2xx calendarList", async () => {
    const { transport } = fakeTransport({
      pages: [{ status: 403, body: { error: { message: "Insufficient Permission" } } }],
    });
    await expect(listCalendars(AUTH, { transport })).rejects.toThrow(
      /google GET \/calendarList failed: 403 Insufficient Permission/,
    );
    await expect(listCalendars(AUTH, { transport })).rejects.not.toThrow(/rt_secret/);
  });

  test("throws a secret-safe error when the token exchange fails", async () => {
    const { transport } = fakeTransport({
      token: { status: 400, body: { error: "invalid_grant", error_description: "Token revoked" } },
    });
    await expect(listCalendars(AUTH, { transport })).rejects.toThrow(
      /google token exchange failed: Token revoked/,
    );
    await expect(listCalendars(AUTH, { transport })).rejects.not.toThrow(/rt_secret/);
  });

  test("forwards an optional client secret in the token POST", async () => {
    const { transport, calls } = fakeTransport({ pages: [{ body: { items: [] } }] });
    await listCalendars({ ...AUTH, clientSecret: "cs_secret" }, { transport });
    expect(calls[0]?.body).toContain("client_secret=cs_secret");
  });

  test("skips rows without an id and tolerates a non-array items", async () => {
    const { transport } = fakeTransport({
      pages: [{ body: { items: [{ summary: "no id" }, { id: "ok@x", summary: "OK" }] } }],
    });
    const a = await listCalendars(AUTH, { transport });
    expect(a.calendars.map((c) => c.id)).toEqual(["ok@x"]);
    const { transport: t2 } = fakeTransport({ pages: [{ body: { items: "nope" } }] });
    const b = await listCalendars(AUTH, { transport: t2 });
    expect(b.calendars).toEqual([]);
  });

  test("onProgress ticks per round-trip and a throwing reporter does not fail", async () => {
    const { transport } = fakeTransport({
      pages: [
        { body: { items: [{ id: "a@x", summary: "A" }], nextPageToken: "p2" } },
        { body: { items: [{ id: "b@x", summary: "B" }] } },
      ],
    });
    let ticks = 0;
    const { calendars } = await listCalendars(AUTH, {
      transport,
      onProgress: () => {
        ticks += 1;
        throw new Error("boom");
      },
    });
    // 1 (token) + 2 (pages) = 3 ticks.
    expect(ticks).toBe(3);
    expect(calendars).toHaveLength(2);
  });
});

describe("calendars — renderConfigBlock", () => {
  test("sets calendarId to the primary and comments the alternatives", () => {
    const lines = renderConfigBlock({
      calendars: [
        {
          id: "primary",
          summary: "Me",
          timeZone: "Asia/Tokyo",
          primary: true,
          accessRole: "owner",
        },
        { id: "work@x", summary: "Work", timeZone: "UTC", primary: false, accessRole: "reader" },
      ],
    });
    const text = lines.join("\n");
    expect(lines[0]).toBe("[connectors.google]");
    expect(text).toContain("enabled = true");
    expect(text).toContain('calendarId = "primary"  # Me, Asia/Tokyo, primary');
    expect(text).toContain('# calendarId = "work@x"  # Work, UTC');
    expect(text).toContain("# calendarId is a single calendar id");
  });

  test("falls back to a primary placeholder when nothing is discovered", () => {
    const lines = renderConfigBlock({ calendars: [] });
    expect(lines).toContain('calendarId = "primary"');
    expect(lines.join("\n")).not.toContain("# calendarId =");
  });
});
