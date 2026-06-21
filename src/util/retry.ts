/**
 * Generic retry/backoff for transient remote failures (Issue #267).
 *
 * Suasor's `fetch`-based egress paths each grew their own ad-hoc 429/5xx retry
 * (Slack `connectors/slack/_fetch.ts`, GitHub `connectors/github/_fetch.ts`,
 * ADR-0019). Embedding's external backends (OpenAI / Voyage) had *none*: a single
 * 429/5xx threw `EmbeddingError`, and a large sync could lose every vector to one
 * blip. This module factors the shared policy — exponential backoff + jitter,
 * `Retry-After` honoured (capped), retry on 429/5xx only — into one place that
 * both the embedding client and connectors can reuse (Issue #269 reuses it from
 * the connector side). It is transport-agnostic: it retries any thrown operation
 * and exposes HTTP-aware helpers for the common case.
 *
 * Policy mirrors ADR-0019 / opshub: default 3 attempts; honour a `Retry-After`
 * (seconds, capped at {@link MAX_RETRY_AFTER_MS}); otherwise back off
 * `base * 2^(attempt-1)` (default base 1s → 1s/2s/4s) with **full jitter** so
 * many concurrent callers don't retry in lockstep (thundering herd). `fetchImpl`
 * and `sleep` are injectable so tests exercise the policy with no real waiting.
 */

/** Default attempts including the first try. */
export const DEFAULT_MAX_ATTEMPTS = 3;
/**
 * Default per-attempt timeout (ms) for connector HTTP fetch paths (Issue #269).
 * A hung host (no response, no error) would otherwise pin a bulk-sync worker slot
 * forever; under the bounded pool that can starve the other connectors. Each
 * attempt aborts after this budget and is retried as a transient failure. Connector
 * transports pass it through {@link FetchWithRetryOptions.timeoutMs}; it is opt-in
 * (the util default stays `0` = no timeout) so non-connector callers are unaffected.
 */
export const DEFAULT_CONNECTOR_TIMEOUT_MS = 30_000;
/** Default base backoff (ms); doubles each attempt before jitter. */
export const DEFAULT_BASE_BACKOFF_MS = 1000;
/** Default cap on a single backoff/`Retry-After` wait (ms). */
export const MAX_RETRY_AFTER_MS = 60_000;

/** Sleep `ms` real time; injectable so tests pass a no-op. */
export type SleepLike = (ms: number) => Promise<void>;

const defaultSleep: SleepLike = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Random in `[0, n)`; injectable so tests make jitter deterministic. */
export type RandomLike = () => number;

export interface WithRetryOptions<T> {
  /** Max attempts including the first (default {@link DEFAULT_MAX_ATTEMPTS}). */
  maxAttempts?: number;
  /** Base backoff in ms (default {@link DEFAULT_BASE_BACKOFF_MS}). */
  baseBackoffMs?: number;
  /** Cap on any single wait in ms (default {@link MAX_RETRY_AFTER_MS}). */
  maxBackoffMs?: number;
  /**
   * Whether a successful result should be retried (e.g. a `Response` whose
   * `status` is 429/5xx). Returns the wait in ms to honour (e.g. parsed
   * `Retry-After`), or `null`/`undefined` to use computed backoff, or `false`
   * when the result is terminal (not retryable). Default: never retry results.
   */
  shouldRetryResult?: (result: T, attempt: number) => number | null | false | undefined;
  /**
   * Whether a thrown error should be retried (transient network failure).
   * Default: retry every thrown error (the caller-supplied op decides what to
   * throw). Return `false` to fail fast on a known-terminal error.
   */
  shouldRetryError?: (error: unknown, attempt: number) => boolean;
  /** Sleep override (tests inject a no-op). */
  sleep?: SleepLike;
  /** Randomness override for jitter (tests inject a fixed value). */
  random?: RandomLike;
}

/**
 * Full-jitter backoff for `attempt` (1-based): a random wait in
 * `[0, min(cap, base * 2^(attempt-1)))`. Full jitter (AWS architecture blog)
 * spreads concurrent retries better than equal/decorrelated jitter for our
 * burst-of-embeddings workload. Returns `0` for non-positive base.
 */
export function jitteredBackoffMs(
  attempt: number,
  baseMs: number,
  capMs: number,
  random: RandomLike = Math.random,
): number {
  if (baseMs <= 0) return 0;
  const exp = baseMs * 2 ** Math.max(0, attempt - 1);
  const ceiling = Math.min(capMs, exp);
  return Math.floor(random() * ceiling);
}

/**
 * Parse an HTTP `Retry-After` header into capped milliseconds, or `null` when
 * absent/invalid. Supports the numeric (delta-seconds) form; an HTTP-date form
 * is treated as absent (callers fall back to computed backoff). The cap stops a
 * hostile/huge value from hanging the process.
 */
export function parseRetryAfterMs(
  headers: Pick<Headers, "get">,
  capMs = MAX_RETRY_AFTER_MS,
): number | null {
  const raw = headers.get("retry-after");
  if (raw === null) return null;
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(seconds * 1000, capMs);
}

/** HTTP statuses that are transient and worth retrying (rate limit + server). */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Run `op` with retry/backoff. On each attempt:
 *
 * 1. call `op()`. If it throws and `shouldRetryError` allows (default: yes) and
 *    attempts remain, back off and retry; otherwise rethrow.
 * 2. if it resolves, consult `shouldRetryResult`: a number/`null` means retry
 *    (honouring the returned wait, else computed backoff) when attempts remain;
 *    `false`/`undefined` (default) returns the result as-is.
 *
 * The final attempt's outcome (resolved value or thrown error) is always
 * returned/propagated even if it would otherwise be retryable — the caller's own
 * error handling then decides.
 */
export async function withRetry<T>(
  op: () => Promise<T>,
  options: WithRetryOptions<T> = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
  const maxBackoffMs = options.maxBackoffMs ?? MAX_RETRY_AFTER_MS;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  for (let attempt = 1; ; attempt += 1) {
    const isLast = attempt >= maxAttempts;
    try {
      const result = await op();
      if (isLast) return result;
      const decision = options.shouldRetryResult?.(result, attempt);
      if (decision === false || decision === undefined) return result;
      const wait = decision ?? jitteredBackoffMs(attempt, baseBackoffMs, maxBackoffMs, random);
      await sleep(Math.min(wait, maxBackoffMs));
    } catch (error) {
      if (isLast || options.shouldRetryError?.(error, attempt) === false) throw error;
      await sleep(jitteredBackoffMs(attempt, baseBackoffMs, maxBackoffMs, random));
    }
  }
}

export interface FetchWithRetryOptions
  extends Omit<WithRetryOptions<Response>, "shouldRetryResult"> {
  /** `fetch` override (tests inject a fake to control status/headers). */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  /**
   * Per-request timeout in ms. When set, each attempt aborts (and is retried as a
   * transient failure) if it exceeds the budget. `0`/undefined disables the
   * timeout. Combines with any `signal` already on `init`.
   */
  timeoutMs?: number;
}

/**
 * `fetch` with retry/backoff for the common HTTP case: retry on 429/5xx
 * (honouring `Retry-After`) and on transient network throws, with an optional
 * per-attempt timeout. Returns the final `Response` (even if 429/5xx on the last
 * attempt) so the caller's existing status handling decides the outcome.
 */
export function fetchWithRetry(
  url: string,
  init: RequestInit | undefined,
  options: FetchWithRetryOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? ((input, requestInit) => fetch(input, requestInit));
  const timeoutMs = options.timeoutMs ?? 0;
  return withRetry<Response>(() => fetchOnce(url, init, fetchImpl, timeoutMs), {
    ...options,
    shouldRetryResult: (res) =>
      isRetryableStatus(res.status) ? parseRetryAfterMs(res.headers) : false,
  });
}

/** One `fetch` attempt with an optional abort-on-timeout budget. */
async function fetchOnce(
  url: string,
  init: RequestInit | undefined,
  fetchImpl: NonNullable<FetchWithRetryOptions["fetchImpl"]>,
  timeoutMs: number,
): Promise<Response> {
  if (timeoutMs <= 0) return fetchImpl(url, init);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Chain a caller-supplied signal so an outer abort still propagates. Handle the
  // already-aborted case too: a listener added after the event fired never runs,
  // so an outer signal that aborted before this attempt started would be ignored.
  const outer = init?.signal;
  const onOuterAbort = () => controller.abort();
  if (outer?.aborted) controller.abort();
  else outer?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuterAbort);
  }
}
