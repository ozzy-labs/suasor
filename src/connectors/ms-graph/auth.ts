/**
 * Microsoft Graph credential validation for `ms-graph auth test` (Issue #85,
 * ADR-0011 §運用 verb を Slack 以外へ拡張).
 *
 * The ms-graph connector uses the **app-only client-credentials** flow
 * (`@azure/msal-node`, `clientSecret`), not a user refresh token. The closest
 * parity to "refresh → access" is the client-credentials token request: a POST
 * to the tenant token endpoint exchanging `client_secret` for an access token.
 * A successful exchange proves the client secret + tenant/client ids are valid
 * and reports the granted scope (`.default` resolves to the app's configured
 * application permissions).
 *
 * Import-clean (ADR-0007): no MSAL / Graph SDK. The default transport uses the
 * global `fetch` (no SDK) — building the connector / CLI registry never pulls
 * the SDKs. The client secret is never echoed in thrown errors.
 */

/** Identity + granted scope resolved from a successful token exchange. */
export interface MsGraphAuthResult {
  /** Granted scope from the token response (`.default`-resolved app permissions). */
  readonly scope: string;
  /** Token lifetime in seconds, when reported. */
  readonly expiresIn: number | null;
}

/** Inputs the token exchange needs (tenant + client + secret). */
export interface MsGraphAuthInput {
  readonly tenantId: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

/** One token round-trip, decoupled from `fetch` so tests inject a fake. */
export type MsGraphAuthTransport = (
  input: MsGraphAuthInput,
) => Promise<{ status: number; body: Record<string, unknown> }>;

/** Default transport: a client-credentials POST to the tenant token endpoint. */
const defaultTransport: MsGraphAuthTransport = async ({ tenantId, clientId, clientSecret }) => {
  const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const form = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  const res = await fetch(url, {
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
 * Verify ms-graph app-only credentials by acquiring an access token.
 *
 * @throws {Error} when the token endpoint returns a non-2xx (message carries the
 *   AAD `error` / `error_description`, never the client secret).
 */
export async function testMsGraphAuth(
  input: MsGraphAuthInput,
  transport: MsGraphAuthTransport = defaultTransport,
): Promise<MsGraphAuthResult> {
  const { status, body } = await transport(input);
  if (status < 200 || status >= 300 || asString(body.access_token).length === 0) {
    const detail =
      asString(body.error_description) ||
      asString(body.error) ||
      `HTTP ${status}` ||
      "unknown error";
    throw new Error(`ms-graph token exchange failed: ${detail}`);
  }
  const expiresInRaw = body.expires_in;
  return {
    scope: asString(body.scope),
    expiresIn: typeof expiresInRaw === "number" ? expiresInRaw : null,
  };
}
