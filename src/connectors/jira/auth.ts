/**
 * Jira credential building + `jira auth test` probe (Issue #85 pattern,
 * ADR-0011 §運用 verb generalized to non-Slack connectors).
 *
 * The jira connector authenticates one of two ways, resolved from config:
 * - **Cloud** (the default): HTTP Basic with `email:apiToken`. The `email` is a
 *   non-secret config value; the API token is the keychain secret `token`.
 * - **self-hosted** (`auth = "bearer"`): a bearer PAT (Personal Access Token).
 *   The PAT is the keychain secret `token`; no `email` is needed.
 *
 * `jira auth test` proves the credential is live by calling `GET /rest/api/3/myself`
 * — the lightest authenticated Jira read — and reports the resolved account so the
 * operator can confirm which identity the connector ingests as.
 *
 * Import-clean (ADR-0007): no SDK. The default transport uses the global `fetch`
 * (same pattern as `src/connectors/notion/auth.ts`), wrapped in the shared
 * {@link fetchWithRetry} so a transient 429/5xx (with `Retry-After` honoured) is
 * retried rather than failing the check (Issue #269). The token is never echoed in
 * thrown errors.
 */
import {
  DEFAULT_CONNECTOR_TIMEOUT_MS,
  type FetchWithRetryOptions,
  fetchWithRetry,
} from "../../util/retry.ts";
import { DEFAULT_API_BASE, type JiraAuth } from "./client.ts";

/** Auth scheme: Cloud `basic` (email + API token) or self-hosted `bearer` (PAT). */
export type JiraAuthScheme = "basic" | "bearer";

/** Self-hosted REST API base path (Jira Server / Data Center use v2). */
export const SELF_HOSTED_API_BASE = "/rest/api/2";

/** Base64-encode a `user:pass` pair for an HTTP Basic header (no Buffer dep). */
export function basicCredential(email: string, token: string): string {
  // btoa is available in Bun / modern runtimes; ASCII-safe for email:token.
  return `Basic ${btoa(`${email}:${token}`)}`;
}

/**
 * Build the resolved {@link JiraAuth} (host + `Authorization` header + REST base)
 * from the scheme, host, optional email, and the secret token. Throws when a
 * required input is missing so the failure is explicit (the token is never echoed).
 *
 * - `basic` requires `email` (Cloud Basic is `email:apiToken`).
 * - `bearer` ignores `email` (a PAT carries the identity).
 * - `apiBase` defaults to Cloud's `/rest/api/3`; `bearer` (self-hosted) defaults
 *   to `/rest/api/2` unless an explicit base is supplied.
 */
export function buildJiraAuth(input: {
  scheme: JiraAuthScheme;
  host: string;
  email?: string;
  token: string;
  apiBase?: string;
}): JiraAuth {
  const host = input.host.trim();
  if (!host) throw new Error("jira: host is required in config");
  if (!input.token) throw new Error("jira: no API token / PAT configured");
  let authorization: string;
  if (input.scheme === "bearer") {
    authorization = `Bearer ${input.token}`;
  } else {
    const email = (input.email ?? "").trim();
    if (!email) throw new Error("jira: email is required in config for Cloud (basic) auth");
    authorization = basicCredential(email, input.token);
  }
  const apiBase =
    input.apiBase ?? (input.scheme === "bearer" ? SELF_HOSTED_API_BASE : DEFAULT_API_BASE);
  return { host, authorization, apiBase };
}

/** Identity resolved from a successful `GET /rest/api/3/myself`. */
export interface JiraAuthResult {
  /** Account display name, when present. */
  readonly displayName: string;
  /** Account email, when present (Cloud only). */
  readonly email: string;
}

/** One identity round-trip, decoupled from `fetch` so tests inject a fake. */
export type JiraAuthTransport = (
  auth: JiraAuth,
) => Promise<{ status: number; body: Record<string, unknown> }>;

/**
 * Build the default transport: a `GET <apiBase>/myself`, run through
 * {@link fetchWithRetry} so a transient 429/5xx is retried (Issue #269). `retry`
 * is injectable (`fetchImpl` / `sleep`) so a test can drive
 * "429 → Retry-After → success" with no real waiting.
 */
export function makeDefaultTransport(retry: FetchWithRetryOptions = {}): JiraAuthTransport {
  const opts = { timeoutMs: DEFAULT_CONNECTOR_TIMEOUT_MS, ...retry };
  return async (auth) => {
    const apiBase = auth.apiBase ?? DEFAULT_API_BASE;
    const res = await fetchWithRetry(
      `https://${auth.host}${apiBase}/myself`,
      {
        method: "GET",
        headers: { Authorization: auth.authorization, Accept: "application/json" },
      },
      opts,
    );
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      // Non-JSON error body → leave empty; status drives the verdict.
    }
    return { status: res.status, body };
  };
}

const defaultTransport: JiraAuthTransport = makeDefaultTransport();

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Verify a Jira credential by resolving the current account.
 *
 * @throws {Error} when `GET <apiBase>/myself` returns a non-2xx (message carries
 *   the HTTP status + Jira message, never the credential).
 */
export async function testJiraAuth(
  auth: JiraAuth,
  transport: JiraAuthTransport = defaultTransport,
): Promise<JiraAuthResult> {
  const { status, body } = await transport(auth);
  if (status < 200 || status >= 300) {
    const detail =
      (Array.isArray(body.errorMessages) && asString(body.errorMessages[0])) ||
      asString(body.message) ||
      `HTTP ${status}`;
    throw new Error(`jira GET /myself failed: ${status} ${detail}`);
  }
  return {
    displayName: asString(body.displayName),
    email: asString(body.emailAddress),
  };
}
