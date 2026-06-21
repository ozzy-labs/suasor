/**
 * Shared 429/5xx backoff on the google / box / ms-graph `fetch` paths (Issue
 * #269). Each connector's `makeDefaultTransport({ fetchImpl, sleep })` routes its
 * `fetch` through the shared `withRetry` policy (src/util/retry.ts), reusing the
 * same util the Slack / GitHub `_fetch.ts` already had. These tests drive
 * "429 → Retry-After → success" and "retries exhausted → last response" with an
 * injected fake fetch and a no-op sleep — no real network, no real waiting.
 */
import { describe, expect, test } from "bun:test";
import { makeDefaultTransport as boxAuthTransport } from "../../src/connectors/box/auth.ts";
import { makeDefaultTransport as boxFoldersTransport } from "../../src/connectors/box/folders.ts";
import { makeDefaultTransport as googleAuthTransport } from "../../src/connectors/google/auth.ts";
import { makeDefaultTransport as googleCalendarsTransport } from "../../src/connectors/google/calendars.ts";
import { makeDefaultTransport as msGraphAuthTransport } from "../../src/connectors/ms-graph/auth.ts";

/** A `sleep` spy that records requested delays without actually waiting. */
function fakeSleep(): { sleep: (ms: number) => Promise<void>; waited: number[] } {
  const waited: number[] = [];
  return { sleep: async (ms) => void waited.push(ms), waited };
}

/**
 * Build a fake `fetch` returning the queued responses in order (the last one
 * repeats once the queue drains). Each entry is a `{ status, retryAfter?, json }`
 * descriptor turned into a minimal `Response`-like with `.status`, `.headers`,
 * and `.json()`.
 */
function fakeFetch(responses: Array<{ status: number; retryAfter?: string; json?: unknown }>): {
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  getCalls: () => number;
} {
  let i = 0;
  let calls = 0;
  const fetchImpl = async (_url: string, _init?: RequestInit): Promise<Response> => {
    calls += 1;
    const r = responses[Math.min(i, responses.length - 1)] ?? { status: 0 };
    i += 1;
    const headers = new Headers(r.retryAfter ? { "retry-after": r.retryAfter } : {});
    return { status: r.status, headers, json: async () => r.json ?? {} } as unknown as Response;
  };
  return { fetchImpl, getCalls: () => calls };
}

describe("google auth backoff", () => {
  test("429 → Retry-After → success retries then resolves the 200", async () => {
    const { sleep, waited } = fakeSleep();
    const { fetchImpl, getCalls } = fakeFetch([
      { status: 429, retryAfter: "1" },
      { status: 200, json: { access_token: "at" } },
    ]);
    const transport = googleAuthTransport({ fetchImpl, sleep });
    const res = await transport({ clientId: "c", refreshToken: "rt" });
    expect(res.status).toBe(200);
    expect((res.body as { access_token: string }).access_token).toBe("at");
    expect(waited).toEqual([1000]); // honoured Retry-After (1s)
    expect(getCalls()).toBe(2);
  });

  test("retries exhausted returns the last (still-429) response", async () => {
    const { sleep } = fakeSleep();
    const { fetchImpl, getCalls } = fakeFetch([{ status: 429, retryAfter: "1" }]);
    const transport = googleAuthTransport({ fetchImpl, sleep });
    const res = await transport({ clientId: "c", refreshToken: "rt" });
    expect(res.status).toBe(429);
    expect(getCalls()).toBe(3); // DEFAULT_MAX_ATTEMPTS
  });
});

describe("box auth backoff", () => {
  test("503 → success retries then resolves", async () => {
    const { sleep, waited } = fakeSleep();
    const { fetchImpl } = fakeFetch([
      { status: 503 },
      { status: 200, json: { login: "u@x", name: "U" } },
    ]);
    const transport = boxAuthTransport({ fetchImpl, sleep });
    const res = await transport("tok");
    expect(res.status).toBe(200);
    expect((res.body as { login: string }).login).toBe("u@x");
    expect(waited.length).toBe(1); // one computed backoff (no Retry-After)
  });
});

describe("ms-graph auth backoff", () => {
  test("429 → success retries then resolves", async () => {
    const { sleep, waited } = fakeSleep();
    const { fetchImpl } = fakeFetch([
      { status: 429, retryAfter: "2" },
      { status: 200, json: { access_token: "at", scope: "x", expires_in: 3600 } },
    ]);
    const transport = msGraphAuthTransport({ fetchImpl, sleep });
    const res = await transport({ tenantId: "t", clientId: "c", clientSecret: "s" });
    expect(res.status).toBe(200);
    expect(waited).toEqual([2000]);
  });
});

describe("google calendars backoff", () => {
  test("429 → success on a calendarList page", async () => {
    const { sleep, waited } = fakeSleep();
    const { fetchImpl } = fakeFetch([
      { status: 429, retryAfter: "1" },
      { status: 200, json: { items: [] } },
    ]);
    const transport = googleCalendarsTransport({ fetchImpl, sleep });
    const res = await transport({
      method: "GET",
      url: "https://www.googleapis.com/calendar/v3/users/me/calendarList",
      headers: { Authorization: "Bearer at" },
    });
    expect(res.status).toBe(200);
    expect(waited).toEqual([1000]);
  });
});

describe("box folders backoff", () => {
  test("500 → success on a folder items page", async () => {
    const { sleep, waited } = fakeSleep();
    const { fetchImpl } = fakeFetch([
      { status: 500 },
      { status: 200, json: { entries: [], next_marker: "" } },
    ]);
    const transport = boxFoldersTransport({ fetchImpl, sleep });
    const res = await transport({ token: "tok", folderId: "0" });
    expect(res.status).toBe(200);
    expect(waited.length).toBe(1);
  });

  test("a non-retryable 404 returns immediately (no backoff)", async () => {
    const { sleep, waited } = fakeSleep();
    const { fetchImpl } = fakeFetch([{ status: 404, json: { message: "not found" } }]);
    const transport = boxFoldersTransport({ fetchImpl, sleep });
    const res = await transport({ token: "tok", folderId: "missing" });
    expect(res.status).toBe(404);
    expect(waited).toEqual([]); // 4xx (non-429) is terminal
  });
});

describe("per-attempt timeout default (Issue #269)", () => {
  test("a hung host is aborted (per-attempt timeout) and retried, then succeeds", async () => {
    // The default per-attempt timeout (DEFAULT_CONNECTOR_TIMEOUT_MS) means a fetch
    // that never resolves on its own is aborted and retried as a transient failure
    // rather than pinning a bulk-sync worker forever. We force a *short* timeout via
    // the injectable retry options so the test does not wait the real budget: the
    // first attempt hangs until aborted (its signal fires), the second resolves 200.
    const { sleep, waited } = fakeSleep();
    let attempt = 0;
    const fetchImpl = (_url: string, init?: RequestInit): Promise<Response> => {
      attempt += 1;
      if (attempt === 1) {
        // Hang until the per-attempt AbortController aborts us.
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      }
      return Promise.resolve({
        status: 200,
        headers: new Headers(),
        json: async () => ({ login: "u@x", name: "U" }),
      } as unknown as Response);
    };
    const transport = boxAuthTransport({ fetchImpl, sleep, timeoutMs: 5 });
    const res = await transport("tok");
    expect(res.status).toBe(200);
    expect(attempt).toBe(2); // first attempt timed out, second succeeded
    expect(waited.length).toBe(1); // one backoff between the timed-out attempt and the retry
  });
});
