/**
 * GitHub PAT validation leaf (`github auth test`, ADR-0011 generalised). Covers
 * the injected-transport contract (identity + scopes + non-2xx error that never
 * leaks the token) plus the default-transport wiring: a real `githubFetch` round
 * trip pins the current API version and retries a 429 (Issue #224). No SDK.
 */
import { describe, expect, test } from "bun:test";
import { GITHUB_API_VERSION } from "../../../src/connectors/github/_fetch.ts";
import {
  type GithubAuthResult,
  type GithubAuthTransport,
  testGithubAuth,
} from "../../../src/connectors/github/auth.ts";

describe("auth — testGithubAuth (injected transport)", () => {
  test("resolves login + granted scopes from a 200", async () => {
    const transport: GithubAuthTransport = async () => ({
      status: 200,
      scopesHeader: "repo, read:org",
      body: { login: "octocat" },
    });
    const r: GithubAuthResult = await testGithubAuth("ghp_x", transport);
    expect(r.login).toBe("octocat");
    expect(r.scopes).toBe("repo, read:org");
  });

  test("throws with status + GitHub message and never echoes the token", async () => {
    const transport: GithubAuthTransport = async () => ({
      status: 401,
      scopesHeader: null,
      body: { message: "Bad credentials" },
    });
    await expect(testGithubAuth("ghp_secret", transport)).rejects.toThrow(
      /github GET \/user failed: 401 Bad credentials/,
    );
    await expect(testGithubAuth("ghp_secret", transport)).rejects.not.toThrow(/ghp_secret/);
  });
});

describe("auth — default transport wiring (Issue #224)", () => {
  test("pins the current API version and retries a 429 through githubFetch", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<Record<string, string>> = [];
    let i = 0;
    const queued: Array<{ status: number; headers: Record<string, string>; body: unknown }> = [
      { status: 429, headers: { "retry-after": "0" }, body: {} },
      { status: 200, headers: { "x-oauth-scopes": "repo" }, body: { login: "octocat" } },
    ];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      calls.push(init?.headers as Record<string, string>);
      const r = queued[Math.min(i, queued.length - 1)];
      i += 1;
      return {
        status: r?.status ?? 200,
        headers: new Headers(r?.headers ?? {}),
        json: async () => r?.body ?? {},
      } as unknown as Response;
    }) as unknown as typeof fetch;
    try {
      const r = await testGithubAuth("ghp_x");
      expect(r.login).toBe("octocat");
      expect(r.scopes).toBe("repo");
      expect(calls).toHaveLength(2); // 429 then 200
      expect(calls[0]?.["X-GitHub-Api-Version"]).toBe(GITHUB_API_VERSION);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
