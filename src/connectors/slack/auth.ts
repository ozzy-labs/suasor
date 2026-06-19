/**
 * Slack token validation for `slack auth test` (ADR-0011).
 *
 * Calls `auth.test` to verify the token and identify its principal, and reads
 * the **granted** OAuth scopes from the `x-oauth-scopes` response header (the
 * documented surface for "what can this token do"). A single round-trip yields
 * validity + principal + scopes — the readiness block ({@link
 * import("./scopes.ts").renderFeaturesBlock}) is derived from that with no extra
 * call.
 *
 * Import-clean (ADR-0007): no Slack SDK. The default transport uses the global
 * `fetch`, lazily, inside {@link testToken} — top-level imports are types only.
 * The resolved token is never echoed in thrown errors; we surface the Slack API
 * `error` code (a documented short string) instead.
 */

/** Identity + granted scopes resolved from a successful `auth.test`. */
export interface SlackTokenTest {
  /** `bot` when `auth.test` returns a `bot_id`, else `user` (opshub ADR-0018). */
  readonly principal: "bot" | "user";
  readonly team: string;
  readonly teamId: string;
  readonly user: string;
  readonly userId: string;
  /** Comma-separated granted scopes from `x-oauth-scopes` (empty when absent). */
  readonly scopes: string;
}

/** One `auth.test` round-trip, decoupled from `fetch` so tests inject a fake. */
export type SlackAuthTransport = (
  token: string,
) => Promise<{ scopesHeader: string | null; body: Record<string, unknown> }>;

/** Default transport: a single `fetch` POST to `auth.test`, reading the scope header. */
const defaultTransport: SlackAuthTransport = async (token) => {
  const res = await fetch("https://slack.com/api/auth.test", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
    },
  });
  return {
    scopesHeader: res.headers.get("x-oauth-scopes"),
    body: (await res.json()) as Record<string, unknown>,
  };
};

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Verify a Slack token and resolve its principal + granted scopes.
 *
 * @throws {Error} when `auth.test` returns `ok: false` (message carries the
 *   Slack `error` code, never the token).
 */
export async function testToken(
  token: string,
  transport: SlackAuthTransport = defaultTransport,
): Promise<SlackTokenTest> {
  const { body, scopesHeader } = await transport(token);
  if (body.ok !== true) {
    throw new Error(`slack auth.test failed: ${asString(body.error) || "unknown error"}`);
  }
  const principal: "bot" | "user" = asString(body.bot_id).length > 0 ? "bot" : "user";
  return {
    principal,
    team: asString(body.team),
    teamId: asString(body.team_id),
    user: asString(body.user),
    userId: asString(body.user_id),
    scopes: scopesHeader ?? "",
  };
}
