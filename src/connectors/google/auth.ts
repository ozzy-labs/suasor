/**
 * Google credential validation for `google auth test` (Issue #85, ADR-0011 §運用
 * verb を Slack 以外へ拡張).
 *
 * The google connector authenticates with an OAuth2 **refresh token** (the
 * keychain secret `refreshToken`) plus the `clientId` from config. This verb
 * proves the refresh token still mints an access token: a POST to Google's token
 * endpoint exchanging `grant_type=refresh_token` for an access token. A
 * successful exchange reports the granted `scope` so the operator can confirm
 * the read scopes the connector needs are present.
 *
 * Some Google client types (installed / desktop apps) carry a client secret; it
 * is accepted optionally via the keychain secret `clientSecret` and forwarded
 * only when present, so a public client without one still works (parity with the
 * connector's OAuth2 client, which passes only clientId + refresh_token).
 *
 * Import-clean (ADR-0007): no `googleapis`. The default transport uses the
 * global `fetch` (no SDK). The refresh token / client secret are never echoed in
 * thrown errors.
 */

/** Granted scope + lifetime resolved from a successful refresh exchange. */
export interface GoogleAuthResult {
  /** Space-separated granted scopes from the token response (empty when absent). */
  readonly scope: string;
  /** Access-token lifetime in seconds, when reported. */
  readonly expiresIn: number | null;
}

/** Inputs the refresh exchange needs. */
export interface GoogleAuthInput {
  readonly clientId: string;
  readonly refreshToken: string;
  /** Optional client secret (installed/web clients); omitted for public clients. */
  readonly clientSecret?: string;
}

/** One token round-trip, decoupled from `fetch` so tests inject a fake. */
export type GoogleAuthTransport = (
  input: GoogleAuthInput,
) => Promise<{ status: number; body: Record<string, unknown> }>;

/** Default transport: a refresh-token POST to Google's OAuth2 token endpoint. */
const defaultTransport: GoogleAuthTransport = async ({ clientId, refreshToken, clientSecret }) => {
  const form = new URLSearchParams({
    client_id: clientId,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  if (clientSecret) form.set("client_secret", clientSecret);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // Non-JSON error body → leave empty; status drives the verdict.
  }
  return { status: res.status, body };
};

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Verify a Google refresh token by exchanging it for an access token.
 *
 * @throws {Error} when the token endpoint returns a non-2xx (message carries the
 *   `error` / `error_description`, never the refresh token).
 */
export async function testGoogleAuth(
  input: GoogleAuthInput,
  transport: GoogleAuthTransport = defaultTransport,
): Promise<GoogleAuthResult> {
  const { status, body } = await transport(input);
  if (status < 200 || status >= 300 || asString(body.access_token).length === 0) {
    const detail =
      asString(body.error_description) ||
      asString(body.error) ||
      `HTTP ${status}` ||
      "unknown error";
    throw new Error(`google token exchange failed: ${detail}`);
  }
  const expiresInRaw = body.expires_in;
  return {
    scope: asString(body.scope),
    expiresIn: typeof expiresInRaw === "number" ? expiresInRaw : null,
  };
}
