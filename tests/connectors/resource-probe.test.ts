/**
 * Per-resource reachability probe classification (ADR-0049, Issue #478).
 *
 * The whole value of this layer is that it never guesses: a 2xx is `reachable`,
 * a definite negative is `unreachable` with the API's own reason, and anything
 * that leaves the question open is `unknown` — never silently promoted to
 * `reachable`. These tests pin that vocabulary, plus the two probe target
 * builders (which must aim at the *configured* id, not a generic list call).
 */
import { describe, expect, test } from "bun:test";
import { googleProbeSpecs } from "../../src/connectors/google/probe.ts";
import { msGraphProbeSpecs } from "../../src/connectors/ms-graph/probe.ts";
import {
  apiErrorDetail,
  probeResource,
  probeResources,
  type ResourceProbeSpec,
  type ResourceProbeTransport,
} from "../../src/connectors/resource-probe.ts";

const SPEC: ResourceProbeSpec = {
  resource: "mail",
  what: 'mailbox of "you@example.com"',
  url: "https://example.invalid/mail",
};

/** A transport that always answers with the given status + body. */
function fixed(status: number, body: Record<string, unknown> = {}): ResourceProbeTransport {
  return async () => ({ status, body });
}

describe("probeResource — verdict vocabulary", () => {
  test("2xx is reachable", async () => {
    const row = await probeResource(SPEC, "tok", fixed(200));
    expect(row.state).toBe("reachable");
    expect(row.detail).toContain("readable");
  });

  test("403 is unreachable and names the permission cause + API reason", async () => {
    const row = await probeResource(
      SPEC,
      "tok",
      fixed(403, { error: { code: "ErrorAccessDenied", message: "Access is denied" } }),
    );
    expect(row.state).toBe("unreachable");
    expect(row.detail).toContain("HTTP 403");
    expect(row.detail).toContain("permission denied");
    expect(row.detail).toContain("ErrorAccessDenied");
  });

  test("404 is unreachable and points at the configured id, not at permissions", async () => {
    const row = await probeResource(
      SPEC,
      "tok",
      fixed(404, { error: { code: "ResourceNotFound", message: "Resource not found" } }),
    );
    expect(row.state).toBe("unreachable");
    expect(row.detail).toContain("check the configured id");
    expect(row.detail).not.toContain("permission denied");
  });

  test("a 5xx that outlived the retries is unknown, never reachable", async () => {
    const row = await probeResource(SPEC, "tok", fixed(503));
    expect(row.state).toBe("unknown");
    expect(row.detail).toContain("HTTP 503");
  });

  test("a transport failure is unknown, never reachable", async () => {
    const row = await probeResource(SPEC, "tok", async () => {
      throw new Error("connect ETIMEDOUT");
    });
    expect(row.state).toBe("unknown");
    expect(row.detail).toContain("ETIMEDOUT");
  });

  test("the access token is never echoed into the detail", async () => {
    const secret = "ya29.super-secret-token";
    const row = await probeResource(SPEC, secret, fixed(403, { error: { message: secret } }));
    // The API body is the only place a secret could leak back in; we surface the
    // API's message, so assert on what *we* add rather than pretending otherwise.
    expect(row.detail.startsWith(SPEC.what)).toBe(true);
    const clean = await probeResource(SPEC, secret, fixed(200));
    expect(clean.detail).not.toContain(secret);
  });
});

describe("apiErrorDetail — the two error-body shapes", () => {
  test("Google's {error:{message,status}}", () => {
    expect(apiErrorDetail({ error: { status: "PERMISSION_DENIED", message: "denied" } })).toBe(
      "PERMISSION_DENIED: denied",
    );
  });

  test("Graph's {error:{code,message}}", () => {
    expect(apiErrorDetail({ error: { code: "ErrorItemNotFound", message: "gone" } })).toBe(
      "ErrorItemNotFound: gone",
    );
  });

  test("OAuth's flat {error, error_description}", () => {
    expect(apiErrorDetail({ error: "invalid_grant", error_description: "expired" })).toBe(
      "expired",
    );
  });

  test("an unrecognizable body yields nothing rather than an invented reason", () => {
    expect(apiErrorDetail({})).toBe("");
    expect(apiErrorDetail({ error: {} })).toBe("");
  });
});

describe("probeResources — one row per spec, in order", () => {
  test("preserves spec order", async () => {
    const specs: ResourceProbeSpec[] = [
      { resource: "a", what: "a", url: "https://example.invalid/a" },
      { resource: "b", what: "b", url: "https://example.invalid/b" },
    ];
    const rows = await probeResources(specs, "tok", fixed(200));
    expect(rows.map((r) => r.resource)).toEqual(["a", "b"]);
  });

  test("no configured resources ⇒ no rows (absence, not a fabricated verdict)", async () => {
    expect(await probeResources([], "tok", fixed(200))).toEqual([]);
  });
});

describe("googleProbeSpecs — targets the configured calendar", () => {
  test("calendar probe reads the configured calendarId, url-encoded", () => {
    const [spec] = googleProbeSpecs(new Set(["calendar"]), "team a@group.calendar.google.com");
    expect(spec?.url).toContain(encodeURIComponent("team a@group.calendar.google.com"));
    expect(spec?.what).toContain("team a@group.calendar.google.com");
  });

  test("only configured resources are probed", () => {
    const specs = googleProbeSpecs(new Set(["drive"]), "primary");
    expect(specs.map((s) => s.resource)).toEqual(["drive"]);
  });

  test("an empty calendarId falls back to primary rather than an empty path", () => {
    const [spec] = googleProbeSpecs(new Set(["calendar"]), "");
    expect(spec?.url).toContain("/calendars/primary");
  });

  test("an unmapped resource name is skipped, not guessed at", () => {
    expect(googleProbeSpecs(new Set(["chat"]), "primary")).toEqual([]);
  });
});

describe("msGraphProbeSpecs — targets the configured user", () => {
  test("each resource probes under the configured user", () => {
    const specs = msGraphProbeSpecs(new Set(["mail", "calendar", "files", "teams"]), "u@x.test");
    expect(specs.map((s) => s.resource)).toEqual(["mail", "calendar", "files", "teams"]);
    for (const spec of specs) {
      expect(spec.url).toContain(`/users/${encodeURIComponent("u@x.test")}/`);
    }
  });

  test("the app-only footgun (user defaulting to 'me') is probed as-is so it surfaces", () => {
    const [spec] = msGraphProbeSpecs(new Set(["mail"]), "me");
    expect(spec?.url).toContain("/users/me/");
  });

  test("teams probes getAllMessages, the endpoint sync uses, not the cheaper /chats", () => {
    // /chats needs only Chat.ReadBasic.All; getAllMessages needs Chat.Read.All
    // plus protected-API consent. Probing the cheap one would report REACHABLE
    // for a credential that cannot read a single message.
    const [spec] = msGraphProbeSpecs(new Set(["teams"]), "u@x.test");
    expect(spec?.url).toContain("/chats/getAllMessages");
  });
});

describe("probe targets match what sync actually reads", () => {
  test("gmail probes the message list, not the narrower-scoped profile call", () => {
    const [spec] = googleProbeSpecs(new Set(["gmail"]), "primary");
    expect(spec?.url).toContain("/messages");
    expect(spec?.url).not.toContain("/profile");
  });
});
