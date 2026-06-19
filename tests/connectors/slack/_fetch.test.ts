import { describe, expect, test } from "bun:test";
import { slackFetch } from "../../../src/connectors/slack/_fetch.ts";

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

describe("slackFetch (ADR-0019 rate-limit retry)", () => {
  test("a 200 success returns immediately with status + headers + body", async () => {
    const { fetchImpl, calls } = fakeFetch([
      {
        status: 200,
        body: { ok: true, channels: [] },
        headers: { "x-oauth-scopes": "users:read" },
      },
    ]);
    const { sleep, waited } = fakeSleep();
    const r = await slackFetch("https://slack.com/api/users.conversations", {
      token: "xoxb-secret",
      fetchImpl,
      sleep,
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, channels: [] });
    expect(r.headers.get("x-oauth-scopes")).toBe("users:read");
    expect(waited).toEqual([]); // no retry
    expect(calls).toHaveLength(1);
    // token rides in the Authorization header, not the URL
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer xoxb-secret",
    );
  });

  test("a 429 honours Retry-After (seconds → ms) then succeeds", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { status: 429, headers: { "retry-after": "3" } },
      { status: 200, body: { ok: true } },
    ]);
    const { sleep, waited } = fakeSleep();
    const r = await slackFetch("https://slack.com/api/auth.test", {
      token: "t",
      fetchImpl,
      sleep,
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(waited).toEqual([3000]); // Retry-After: 3 → 3000ms, not the backoff
    expect(calls).toHaveLength(2);
  });

  test("with no Retry-After header it backs off exponentially (1s, 2s)", async () => {
    const { fetchImpl } = fakeFetch([
      { status: 429 },
      { status: 429 },
      { status: 200, body: { ok: true } },
    ]);
    const { sleep, waited } = fakeSleep();
    const r = await slackFetch("https://slack.com/api/search.messages", {
      token: "t",
      fetchImpl,
      sleep,
    });
    expect(r.body).toEqual({ ok: true });
    expect(waited).toEqual([1000, 2000]); // exponential backoff
  });

  test("a soft 200 ok:false ratelimited body is retried too", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { status: 200, body: { ok: false, error: "ratelimited" } },
      { status: 200, body: { ok: true } },
    ]);
    const { sleep, waited } = fakeSleep();
    const r = await slackFetch("https://slack.com/api/users.info", {
      token: "t",
      fetchImpl,
      sleep,
    });
    expect(r.body).toEqual({ ok: true });
    expect(waited).toEqual([1000]);
    expect(calls).toHaveLength(2);
  });

  test("after exhausting attempts it returns the last (still-limited) response", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { status: 429 },
      { status: 429 },
      { status: 429, body: { ok: false, error: "ratelimited" } },
    ]);
    const { sleep, waited } = fakeSleep();
    const r = await slackFetch("https://slack.com/api/users.conversations", {
      token: "t",
      fetchImpl,
      sleep,
      maxAttempts: 3,
    });
    expect(r.status).toBe(429);
    expect(calls).toHaveLength(3); // no 4th attempt
    expect(waited).toEqual([1000, 2000]); // slept before attempts 2 and 3, not after the last
  });

  test("a non-rate-limit error returns immediately for the caller to handle", async () => {
    const { fetchImpl, calls } = fakeFetch([
      { status: 200, body: { ok: false, error: "invalid_auth" } },
    ]);
    const { sleep, waited } = fakeSleep();
    const r = await slackFetch("https://slack.com/api/auth.test", { token: "t", fetchImpl, sleep });
    expect(r.body).toEqual({ ok: false, error: "invalid_auth" });
    expect(waited).toEqual([]); // not retried
    expect(calls).toHaveLength(1);
  });

  test("an oversized Retry-After is capped so the CLI can't hang", async () => {
    const { fetchImpl } = fakeFetch([
      { status: 429, headers: { "retry-after": "99999" } },
      { status: 200, body: { ok: true } },
    ]);
    const { sleep, waited } = fakeSleep();
    await slackFetch("https://slack.com/api/users.conversations", { token: "t", fetchImpl, sleep });
    expect(waited).toEqual([60_000]); // capped at MAX_RETRY_AFTER_MS
  });
});
