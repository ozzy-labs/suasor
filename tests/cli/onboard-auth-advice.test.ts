/**
 * Auth-test failure classification + recovery advice (Issue #567 item 1).
 *
 * Pure string logic: a transport failure ("fetch failed", errno codes) must
 * steer to connectivity + `auth test`, while an API rejection must steer to
 * `auth set` — the two used to share the same "token saved; fix it" advice,
 * which sent offline users hunting for a new token.
 */
import { describe, expect, test } from "bun:test";
import { authFailureAdvice, classifyAuthFailure } from "../../src/cli/onboard/auth-advice.ts";

describe("classifyAuthFailure", () => {
  test("transport shapes classify as network", () => {
    for (const detail of [
      "fetch failed",
      "connect ECONNREFUSED 127.0.0.1:443",
      "getaddrinfo ENOTFOUND api.github.com",
      "getaddrinfo EAI_AGAIN api.github.com",
      "connect ETIMEDOUT 140.82.112.6:443",
      "UND_ERR_CONNECT_TIMEOUT",
      "ConnectionRefused: Unable to connect",
      "socket hang up",
      "The operation timed out",
    ]) {
      expect(classifyAuthFailure(detail)).toBe("network");
    }
  });

  test("API rejections classify as credential (the conservative default)", () => {
    for (const detail of [
      "github auth test failed: 401 Unauthorized",
      "invalid_auth",
      "Bad credentials",
      "token_revoked",
      "ms-graph: tenantId and clientId are required in config",
    ]) {
      expect(classifyAuthFailure(detail)).toBe("credential");
    }
  });
});

describe("authFailureAdvice", () => {
  test("network → connectivity + `auth test`, never `auth set`", () => {
    const advice = authFailureAdvice("network", "github");
    expect(advice).toContain("could not reach the github API");
    expect(advice).toContain("check connectivity");
    expect(advice).toContain("suasor github auth test");
    expect(advice).not.toContain("auth set");
  });

  test("credential → re-store via `auth set`, then `auth test`", () => {
    const advice = authFailureAdvice("credential", "github");
    expect(advice).toContain("suasor github auth set");
    expect(advice).toContain("suasor github auth test");
  });

  test("the account flag lands on both commands (ADR-0050)", () => {
    const advice = authFailureAdvice("credential", "google", " --account work");
    expect(advice).toContain("suasor google auth set --account work");
    expect(advice).toContain("suasor google auth test --account work");
    expect(authFailureAdvice("network", "google", " --account work")).toContain(
      "suasor google auth test --account work",
    );
  });
});
