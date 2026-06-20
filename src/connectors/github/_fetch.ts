/**
 * Shared rate-limit-aware fetch for GitHub's `fetch`-only operational/discovery
 * paths (Issue #224; generalises ADR-0019's Slack `_fetch.ts` to the non-Slack
 * fetch surface).
 *
 * GitHub's sync hot path runs through `octokit`, whose default `retry` +
 * `throttling` plugins already retry on 429 / secondary rate limits (Retry-After
 * honoured). The `fetch`-based paths — `GET /user` (`auth.ts`) and
 * `GET /user/repos` (`repos.ts`), kept import-clean per ADR-0007 — had no 429
 * handling at all: a rate limit threw immediately (auth check / enumeration
 * died). This wraps the lowest layer — `fetch` itself — because the 429
 * `Retry-After` lives in the HTTP **header**, invisible to the body-only
 * transports the callers expose.
 *
 * Policy mirrors ADR-0019 / opshub: default 3 attempts, honour `Retry-After`
 * (seconds, capped), else 1s / 2s / 4s exponential backoff. GitHub also signals
 * a (secondary) rate limit with a `403` carrying `Retry-After`; that case
 * retries the same way. Every other status returns immediately for the caller's
 * existing handling.
 *
 * Import-clean (ADR-0007): no `octokit`, global `fetch` only. `fetchImpl` and
 * `sleep` are injectable so tests exercise "429 → Retry-After → success" and
 * backoff with no real-time waiting.
 */

/** Current stable GitHub REST API version pin (`X-GitHub-Api-Version`). */
export const GITHUB_API_VERSION = "2026-03-10";

/** Normalised result: status + headers (for `x-oauth-scopes` / `Link`) + parsed body. */
export interface GithubFetchResult {
  readonly status: number;
  readonly headers: Headers;
  /** Parsed JSON body, or `null` when the body was empty / non-JSON. */
  readonly body: unknown;
}

export interface GithubFetchOptions {
  /** Bearer token; sent as `Authorization` and never echoed in errors. */
  readonly token: string;
  /** HTTP method (default `GET`). */
  readonly method?: "GET" | "POST";
  /** Extra request headers merged over the GitHub defaults. */
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
async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * True when this response should be retried as a rate limit. GitHub returns
 * `429` for primary rate limits and a `403` with `Retry-After` for secondary
 * (abuse) rate limits; both are honoured. A `403` *without* `Retry-After` is a
 * plain authorization failure and is **not** retried.
 */
function isRateLimited(status: number, headers: Headers): boolean {
  if (status === 429) return true;
  return status === 403 && headers.get("retry-after") !== null;
}

/**
 * Fetch a GitHub API URL with rate-limit retry, returning status + headers +
 * parsed body. Retries on 429 (and 403 + `Retry-After`), honouring `Retry-After`
 * (capped) and otherwise backing off 1s/2s/4s. After the final attempt the last
 * response is returned as-is so the caller's existing status handling decides the
 * outcome.
 */
export async function githubFetch(
  url: string,
  options: GithubFetchOptions,
): Promise<GithubFetchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const maxAttempts = options.maxAttempts ?? 3;
  const init: RequestInit = {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${options.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      ...options.headers,
    },
  };

  let last: GithubFetchResult = { status: 0, headers: new Headers(), body: null };
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const res = await fetchImpl(url, init);
    last = { status: res.status, headers: res.headers, body: await safeJson(res) };
    if (!isRateLimited(res.status, res.headers) || attempt >= maxAttempts) return last;
    await sleep(retryAfterMs(res.headers) ?? BACKOFF_MS[attempt - 1] ?? MAX_RETRY_AFTER_MS);
  }
  return last;
}
