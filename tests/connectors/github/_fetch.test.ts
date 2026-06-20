/**
 * Shared GitHub fetch-path rate-limit retry (Issue #224; ADR-0019 generalised to
 * the non-Slack fetch surface). Exercises 429 / secondary-limit 403 retry with
 * an injected `fetch` + `sleep`, the API version pin, and the
 * return-last-response-on-exhaustion contract. No network, no SDK.
 */
import { describe, expect, test } from "bun:test";
import { GITHUB_API_VERSION, githubFetch } from "../../../src/connectors/github/_fetch.ts";

/** Build a fake `fetch` that returns the queued responses in order. */
function fakeFetch(
  responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>,
): { fetchImpl: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let i = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (!r) throw new Error("fakeFetch: no response queued");
    return {
      status: r.status,
      headers: new Headers(r.headers ?? {}),
      json: async () => {
        if (r.body === undefined) throw new SyntaxError("no body");
        return r.body;
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

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

describe("githubFetch (Issue #224 rate-limit retry)", () => {
  test("pins the current API version and rides the token in the Authorization header", async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 200, body: { login: "octocat" } }]);
    const { sleep } = fakeSleep();
    await githubFetch("https://api.github.com/user", {
      token: "ghp_secret",
      fetchImpl,
      sleep,
    });
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["X-GitHub-Api-Version"]).toBe(GITHUB_API_VERSION);
    expect(headers["X-GitHub-Api-Version"]).toBe("2026-03-10");
    expect(headers.Accept).toBe("application/vnd.github+json");
    expect(headers.Authorization).toBe("Bearer ghp_secret");
  });

  test("a 200 success returns immediately with status + headers + body, no retry", async () => {
    const { fetchImpl, calls } = fakeFetch([
      {
        status: 200,
        body: [{ full_name: "octocat/hello" }],
        headers: { link: '<https://api.github.com/user/repos?page=2>; rel="next"' },
      },
    ]);
    const { sleep, waited } = fakeSleep();
    const r = await githubFetch("https://api.github.com/user/repos", {
      token: "t",
      fetchImpl,
      sleep,
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual([{ full_name: "octocat/hello" }]);
    expect(r.headers.get("link")).toBe('<https://api.github.com/user/repos?page=2>; rel="next"');
    expect(waited).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  test("a 429 honours Retry-After (seconds → ms) then succeeds", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { status: 429, headers: { "retry-after": "3" } },
      { status: 200, body: { login: "octocat" } },
    ]);
    const { sleep, waited } = fakeSleep();
    const r = await githubFetch("https://api.github.com/user", { token: "t", fetchImpl, sleep });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ login: "octocat" });
    expect(waited).toEqual([3000]); // Retry-After: 3 → 3000ms, not the backoff
    expect(calls).toHaveLength(2);
  });

  test("a secondary-limit 403 with Retry-After is retried like a 429", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { status: 403, headers: { "retry-after": "2" }, body: { message: "secondary rate limit" } },
      { status: 200, body: { login: "octocat" } },
    ]);
    const { sleep, waited } = fakeSleep();
    const r = await githubFetch("https://api.github.com/user", { token: "t", fetchImpl, sleep });
    expect(r.status).toBe(200);
    expect(waited).toEqual([2000]);
    expect(calls).toHaveLength(2);
  });

  test("a plain 403 WITHOUT Retry-After is an auth failure and returns immediately", async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 403, body: { message: "Forbidden" } }]);
    const { sleep, waited } = fakeSleep();
    const r = await githubFetch("https://api.github.com/user", { token: "t", fetchImpl, sleep });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ message: "Forbidden" });
    expect(waited).toEqual([]); // not retried
    expect(calls).toHaveLength(1);
  });

  test("with no Retry-After header it backs off exponentially (1s, 2s)", async () => {
    const { fetchImpl } = fakeFetch([
      { status: 429 },
      { status: 429 },
      { status: 200, body: { login: "octocat" } },
    ]);
    const { sleep, waited } = fakeSleep();
    const r = await githubFetch("https://api.github.com/user", { token: "t", fetchImpl, sleep });
    expect(r.body).toEqual({ login: "octocat" });
    expect(waited).toEqual([1000, 2000]); // exponential backoff
  });

  test("after exhausting attempts it returns the last (still-limited) response", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { status: 429 },
      { status: 429 },
      { status: 429, body: { message: "rate limit exceeded" } },
    ]);
    const { sleep, waited } = fakeSleep();
    const r = await githubFetch("https://api.github.com/user/repos", {
      token: "t",
      fetchImpl,
      sleep,
      maxAttempts: 3,
    });
    expect(r.status).toBe(429);
    expect(r.body).toEqual({ message: "rate limit exceeded" });
    expect(calls).toHaveLength(3); // no 4th attempt
    expect(waited).toEqual([1000, 2000]); // slept before attempts 2 and 3, not after the last
  });

  test("a non-rate-limit error (401) returns immediately for the caller to handle", async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 401, body: { message: "Bad credentials" } }]);
    const { sleep, waited } = fakeSleep();
    const r = await githubFetch("https://api.github.com/user", { token: "t", fetchImpl, sleep });
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ message: "Bad credentials" });
    expect(waited).toEqual([]); // not retried
    expect(calls).toHaveLength(1);
  });

  test("an oversized Retry-After is capped so the CLI can't hang", async () => {
    const { fetchImpl } = fakeFetch([
      { status: 429, headers: { "retry-after": "99999" } },
      { status: 200, body: { login: "octocat" } },
    ]);
    const { sleep, waited } = fakeSleep();
    await githubFetch("https://api.github.com/user", { token: "t", fetchImpl, sleep });
    expect(waited).toEqual([60_000]); // capped at MAX_RETRY_AFTER_MS
  });

  test("a non-JSON / empty body parses to null without throwing", async () => {
    const { fetchImpl } = fakeFetch([{ status: 200 }]); // no body → json() throws
    const { sleep } = fakeSleep();
    const r = await githubFetch("https://api.github.com/user", { token: "t", fetchImpl, sleep });
    expect(r.status).toBe(200);
    expect(r.body).toBeNull();
  });
});
