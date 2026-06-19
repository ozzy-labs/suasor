/**
 * GitHub PAT validation for `github auth test` (Issue #85, ADR-0011 §運用 verb
 * を Slack 以外へ拡張).
 *
 * Calls `GET /user` to verify the Personal Access Token and identify the
 * principal, and reads the **granted** OAuth scopes from the `x-oauth-scopes`
 * response header (the documented surface GitHub exposes for "what can this
 * token do"). A single round-trip yields validity + identity + scopes; the
 * readiness verdict is derived from that with no extra call.
 *
 * Import-clean (ADR-0007): no `octokit`. The default transport uses the global
 * `fetch` (no SDK) — building the connector / CLI registry never pulls octokit.
 * The resolved token is never echoed in thrown errors.
 */

/** Identity + granted scopes resolved from a successful `GET /user`. */
export interface GithubAuthResult {
  /** Authenticated login (e.g. `octocat`). */
  readonly login: string;
  /** Comma-separated granted OAuth scopes from `x-oauth-scopes` (empty when absent). */
  readonly scopes: string;
}

/** One identity round-trip, decoupled from `fetch` so tests inject a fake. */
export type GithubAuthTransport = (options: {
  token: string;
  baseUrl?: string;
}) => Promise<{ status: number; scopesHeader: string | null; body: Record<string, unknown> }>;

/** Default transport: a `GET /user` reading the `x-oauth-scopes` header. */
const defaultTransport: GithubAuthTransport = async ({ token, baseUrl }) => {
  const root = (baseUrl ?? "https://api.github.com").replace(/\/$/, "");
  const res = await fetch(`${root}/user`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // Non-JSON error body (e.g. an HTML 5xx) → leave body empty; status drives it.
  }
  return { status: res.status, scopesHeader: res.headers.get("x-oauth-scopes"), body };
};

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Verify a GitHub PAT and resolve its login + granted scopes.
 *
 * @throws {Error} when `GET /user` returns a non-2xx (message carries the HTTP
 *   status + GitHub `message`, never the token).
 */
export async function testGithubAuth(
  token: string,
  transport: GithubAuthTransport = defaultTransport,
  baseUrl?: string,
): Promise<GithubAuthResult> {
  const { status, scopesHeader, body } = await transport({
    token,
    ...(baseUrl ? { baseUrl } : {}),
  });
  if (status < 200 || status >= 300) {
    const detail = asString(body.message) || "unknown error";
    throw new Error(`github GET /user failed: ${status} ${detail}`);
  }
  return { login: asString(body.login), scopes: scopesHeader ?? "" };
}
