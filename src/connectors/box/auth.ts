/**
 * Box credential validation for `box auth test` (Issue #85, ADR-0011 §運用 verb
 * を Slack 以外へ拡張).
 *
 * The box connector authenticates with an access token (the keychain secret
 * `token`: a Developer Token or an OAuth access token). This verb proves the
 * token is live by calling `GET /2.0/users/me` — the lightest authenticated Box
 * read — and reports the resolved account (login + name) so the operator can
 * confirm which identity the connector ingests as.
 *
 * Import-clean (ADR-0007): no `box-typescript-sdk-gen`. The default transport
 * uses the global `fetch` (no SDK). The token is never echoed in thrown errors.
 */

/** Identity resolved from a successful `GET /2.0/users/me`. */
export interface BoxAuthResult {
  /** Box account login (email), when present. */
  readonly login: string;
  /** Box display name, when present. */
  readonly name: string;
}

/** One identity round-trip, decoupled from `fetch` so tests inject a fake. */
export type BoxAuthTransport = (
  token: string,
) => Promise<{ status: number; body: Record<string, unknown> }>;

/** Default transport: a `GET /2.0/users/me` against the Box API. */
const defaultTransport: BoxAuthTransport = async (token) => {
  const res = await fetch("https://api.box.com/2.0/users/me", {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
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
 * Verify a Box access token by resolving the current account.
 *
 * @throws {Error} when `GET /2.0/users/me` returns a non-2xx (message carries the
 *   HTTP status + Box `message`, never the token).
 */
export async function testBoxAuth(
  token: string,
  transport: BoxAuthTransport = defaultTransport,
): Promise<BoxAuthResult> {
  const { status, body } = await transport(token);
  if (status < 200 || status >= 300) {
    const detail = asString(body.message) || `HTTP ${status}` || "unknown error";
    throw new Error(`box GET /2.0/users/me failed: ${status} ${detail}`);
  }
  return { login: asString(body.login), name: asString(body.name) };
}
