import { describe, expect, test } from "bun:test";
import {
  fetchWithRetry,
  isRetryableStatus,
  jitteredBackoffMs,
  parseRetryAfterMs,
  withRetry,
} from "../../src/util/retry.ts";

/** A `sleep` spy that records the requested delays without actually waiting. */
function fakeSleep(): { sleep: (ms: number) => Promise<void>; waited: number[] } {
  const waited: number[] = [];
  return {
    sleep: async (ms: number) => {
      waited.push(ms);
    },
    waited,
  };
}

/** Build a fake `fetch` returning the queued responses in order. */
function fakeFetch(
  responses: Array<{ status: number; headers?: Record<string, string> } | (() => never)>,
): { fetchImpl: (url: string, init?: RequestInit) => Promise<Response>; calls: RequestInit[] } {
  const calls: RequestInit[] = [];
  let i = 0;
  const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
    calls.push(init ?? {});
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (typeof r === "function") return r();
    return {
      status: r?.status ?? 0,
      headers: new Headers(r?.headers ?? {}),
    } as unknown as Response;
  };
  return { fetchImpl, calls };
}

describe("jitteredBackoffMs", () => {
  test("full jitter stays in [0, base*2^(attempt-1))", () => {
    // random() = 0 → 0; random() ~1 → just under the ceiling.
    expect(jitteredBackoffMs(1, 1000, 60_000, () => 0)).toBe(0);
    expect(jitteredBackoffMs(1, 1000, 60_000, () => 0.999)).toBe(999);
    expect(jitteredBackoffMs(2, 1000, 60_000, () => 0.999)).toBe(1998); // floor(0.999*2000)
    expect(jitteredBackoffMs(3, 1000, 60_000, () => 0.5)).toBe(2000); // 0.5 * 4000
  });

  test("caps the exponential growth at maxBackoffMs", () => {
    expect(jitteredBackoffMs(10, 1000, 5000, () => 0.999)).toBeLessThan(5000);
  });

  test("returns 0 for non-positive base", () => {
    expect(jitteredBackoffMs(3, 0, 60_000, () => 0.9)).toBe(0);
  });
});

describe("parseRetryAfterMs", () => {
  test("parses numeric seconds into capped ms", () => {
    expect(parseRetryAfterMs(new Headers({ "retry-after": "2" }))).toBe(2000);
  });
  test("caps a hostile value", () => {
    expect(parseRetryAfterMs(new Headers({ "retry-after": "9999" }), 60_000)).toBe(60_000);
  });
  test("returns null when absent or invalid", () => {
    expect(parseRetryAfterMs(new Headers())).toBeNull();
    expect(parseRetryAfterMs(new Headers({ "retry-after": "0" }))).toBeNull();
    expect(parseRetryAfterMs(new Headers({ "retry-after": "soon" }))).toBeNull();
  });
});

describe("isRetryableStatus", () => {
  test("429 and 5xx are retryable, others are not", () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
    expect(isRetryableStatus(200)).toBe(false);
  });
});

describe("withRetry (result-based)", () => {
  test("retries while shouldRetryResult asks, then returns the success", async () => {
    const { sleep, waited } = fakeSleep();
    let n = 0;
    const result = await withRetry<number>(async () => ++n, {
      // Retry until we see 3.
      shouldRetryResult: (v) => (v < 3 ? null : false),
      sleep,
      random: () => 0,
      baseBackoffMs: 100,
    });
    expect(result).toBe(3);
    expect(waited.length).toBe(2);
  });

  test("honours the wait returned by shouldRetryResult", async () => {
    const { sleep, waited } = fakeSleep();
    let n = 0;
    await withRetry<number>(async () => ++n, {
      shouldRetryResult: (v) => (v < 2 ? 5000 : false),
      sleep,
    });
    expect(waited).toEqual([5000]);
  });

  test("returns the last result at the attempt cap even if still retryable", async () => {
    const { sleep, waited } = fakeSleep();
    let n = 0;
    const result = await withRetry<number>(async () => ++n, {
      maxAttempts: 2,
      shouldRetryResult: () => null, // always wants retry
      sleep,
      random: () => 0,
    });
    expect(result).toBe(2);
    expect(waited.length).toBe(1);
  });
});

describe("withRetry (error-based)", () => {
  test("retries transient throws then succeeds", async () => {
    const { sleep, waited } = fakeSleep();
    let n = 0;
    const result = await withRetry<string>(
      async () => {
        n += 1;
        if (n < 3) throw new Error("transient");
        return "ok";
      },
      { sleep, random: () => 0 },
    );
    expect(result).toBe("ok");
    expect(waited.length).toBe(2);
  });

  test("rethrows the final error after the attempt cap", async () => {
    const { sleep } = fakeSleep();
    await expect(
      withRetry<string>(
        async () => {
          throw new Error("always");
        },
        { maxAttempts: 2, sleep, random: () => 0 },
      ),
    ).rejects.toThrow("always");
  });

  test("fails fast when shouldRetryError returns false", async () => {
    const { sleep, waited } = fakeSleep();
    let calls = 0;
    await expect(
      withRetry<string>(
        async () => {
          calls += 1;
          throw new Error("terminal");
        },
        { sleep, shouldRetryError: () => false },
      ),
    ).rejects.toThrow("terminal");
    expect(calls).toBe(1);
    expect(waited.length).toBe(0);
  });
});

describe("fetchWithRetry", () => {
  test("retries a 429 honouring Retry-After then returns the 200", async () => {
    const { fetchImpl } = fakeFetch([
      { status: 429, headers: { "retry-after": "3" } },
      { status: 200 },
    ]);
    const { sleep, waited } = fakeSleep();
    const res = await fetchWithRetry("https://api.example.com", undefined, {
      fetchImpl,
      sleep,
      random: () => 0,
    });
    expect(res.status).toBe(200);
    expect(waited).toEqual([3000]);
  });

  test("retries a 5xx with computed backoff", async () => {
    const { fetchImpl } = fakeFetch([{ status: 503 }, { status: 200 }]);
    const { sleep, waited } = fakeSleep();
    const res = await fetchWithRetry("https://api.example.com", undefined, {
      fetchImpl,
      sleep,
      random: () => 0.5,
      baseBackoffMs: 1000,
    });
    expect(res.status).toBe(200);
    expect(waited).toEqual([500]); // 0.5 * 1000
  });

  test("returns the last 429/5xx after the attempt cap", async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 429 }]);
    const { sleep } = fakeSleep();
    const res = await fetchWithRetry("https://api.example.com", undefined, {
      fetchImpl,
      sleep,
      maxAttempts: 3,
      random: () => 0,
    });
    expect(res.status).toBe(429);
    expect(calls.length).toBe(3);
  });

  test("does not retry a non-retryable status (e.g. 400)", async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 400 }]);
    const { sleep } = fakeSleep();
    const res = await fetchWithRetry("https://api.example.com", undefined, { fetchImpl, sleep });
    expect(res.status).toBe(400);
    expect(calls.length).toBe(1);
  });

  test("aborts and retries on a per-request timeout", async () => {
    let attempts = 0;
    // First attempt hangs until aborted; second resolves 200.
    const fetchImpl = (_url: string, init?: RequestInit): Promise<Response> => {
      attempts += 1;
      if (attempts === 1) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      return Promise.resolve({ status: 200, headers: new Headers() } as unknown as Response);
    };
    const { sleep } = fakeSleep();
    const res = await fetchWithRetry("https://api.example.com", undefined, {
      fetchImpl,
      sleep,
      random: () => 0,
      timeoutMs: 1, // trips quickly
    });
    expect(res.status).toBe(200);
    expect(attempts).toBe(2);
  });

  test("a caller-supplied signal still aborts the request under a timeout", async () => {
    const outer = new AbortController();
    let sawAbort = false;
    const fetchImpl = (_url: string, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          sawAbort = true;
          reject(new Error("aborted"));
        });
        // Abort via the outer signal immediately.
        outer.abort();
      });
    const { sleep } = fakeSleep();
    await expect(
      fetchWithRetry(
        "https://api.example.com",
        { signal: outer.signal },
        { fetchImpl, sleep, maxAttempts: 1, timeoutMs: 1000, random: () => 0 },
      ),
    ).rejects.toThrow("aborted");
    expect(sawAbort).toBe(true);
  });

  test("passes through a 200 with no timeout configured", async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 200 }]);
    const res = await fetchWithRetry("https://api.example.com", { method: "POST" }, { fetchImpl });
    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
  });
});
