/**
 * Shared rate-limit-aware fetch for Slack operational/discovery/auth/search
 * paths (ADR-0019; port of opshub's `connectors/slack/_retry.py`).
 *
 * The sync hot path (`conversations.history` / `replies`) runs through
 * `@slack/web-api`, whose `WebClient` already retries on 429 (Retry-After
 * honoured). The `fetch`-based paths (`users.conversations` / `users.info` /
 * `auth.test` / `search.messages`, kept import-clean per ADR-0007/0011) had no
 * 429 handling at all: a rate limit threw (enumeration died) or silently
 * degraded (DM name resolution). This wraps the lowest layer — `fetch` itself —
 * because the 429 `Retry-After` lives in the HTTP **header**, invisible to the
 * body-only transports the callers expose.
 *
 * Policy mirrors opshub: default 3 attempts, honour `Retry-After` (seconds,
 * capped), else 1s / 2s / 4s exponential backoff. A `200` with
 * `ok:false error:"ratelimited"` (Slack's rare soft-limit) retries the same way;
 * every other error returns immediately for the caller's existing handling.
 *
 * Import-clean (ADR-0007): no Slack SDK, global `fetch` only. `fetchImpl` and
 * `sleep` are injectable so tests exercise "429 → Retry-After → success" and
 * backoff with no real-time waiting.
 */

/** Normalised result: status + headers (for `x-oauth-scopes`) + parsed body. */
export interface SlackFetchResult {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

export interface SlackFetchOptions {
  /** Bearer token; sent as `Authorization` and never echoed in errors. */
  readonly token: string;
  /** HTTP method (default `GET`; `auth.test` uses `POST`). */
  readonly method?: "GET" | "POST";
  /** Extra request headers (e.g. `auth.test`'s form content type). */
  readonly headers?: Record<string, string>;
  /** `fetch` override (tests inject a fake to control status/headers). */
  readonly fetchImpl?: typeof fetch;
  /** Sleep override (tests inject a no-op to avoid real backoff waits). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Max attempts including the first (default 3). */
  readonly maxAttempts?: number;
}

/** Exponential backoff (ms) used when no `Retry-After` header is present. */
const BACKOFF_MS: readonly number[] = [1000, 2000, 4000];
/** Cap on an honoured `Retry-After` so a hostile/huge value can't hang the CLI. */
const MAX_RETRY_AFTER_MS = 60_000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Parse `Retry-After` (seconds) into capped ms, or `null` when absent/invalid. */
function retryAfterMs(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (raw === null) return null;
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

/** Read a JSON body without throwing — a 429 often has an empty/non-JSON body. */
async function safeJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** True when this response should be retried as a rate limit. */
function isRateLimited(result: SlackFetchResult): boolean {
  return result.status === 429 || (result.body.ok === false && result.body.error === "ratelimited");
}

/**
 * Fetch a Slack API URL with rate-limit retry, returning status + headers +
 * parsed body. Retries on 429 (and `ok:false error:"ratelimited"`), honouring
 * `Retry-After` (capped) and otherwise backing off 1s/2s/4s. After the final
 * attempt the last response is returned as-is so the caller's existing
 * `body.ok` handling decides the outcome.
 */
export async function slackFetch(
  url: string,
  options: SlackFetchOptions,
): Promise<SlackFetchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const maxAttempts = options.maxAttempts ?? 3;
  const init: RequestInit = {
    method: options.method ?? "GET",
    headers: { Authorization: `Bearer ${options.token}`, ...options.headers },
  };

  let last: SlackFetchResult = { status: 0, headers: new Headers(), body: {} };
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const res = await fetchImpl(url, init);
    last = { status: res.status, headers: res.headers, body: await safeJson(res) };
    if (!isRateLimited(last) || attempt >= maxAttempts) return last;
    await sleep(retryAfterMs(res.headers) ?? BACKOFF_MS[attempt - 1] ?? MAX_RETRY_AFTER_MS);
  }
  return last;
}
