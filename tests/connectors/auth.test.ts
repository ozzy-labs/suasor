/**
 * Per-connector `auth test` probe unit tests (Issue #85). Each probe is a
 * `fetch`-only round-trip with an injectable transport, so these exercise
 * success / failure / scope reporting with no real network and assert the token
 * is never leaked into a thrown error message.
 */
import { describe, expect, test } from "bun:test";
import { testBoxAuth } from "../../src/connectors/box/auth.ts";
import { testGithubAuth } from "../../src/connectors/github/auth.ts";
import { testGoogleAuth } from "../../src/connectors/google/auth.ts";
import { testMsGraphAuth } from "../../src/connectors/ms-graph/auth.ts";

const SECRET = "super-secret-token-value";

describe("github auth probe", () => {
  test("resolves login + scopes from x-oauth-scopes on 200", async () => {
    const result = await testGithubAuth(SECRET, async ({ token }) => {
      expect(token).toBe(SECRET);
      return { status: 200, scopesHeader: "repo, read:org", body: { login: "octocat" } };
    });
    expect(result.login).toBe("octocat");
    expect(result.scopes).toBe("repo, read:org");
  });

  test("empty scope header yields empty scopes (fine-grained PAT)", async () => {
    const result = await testGithubAuth(SECRET, async () => ({
      status: 200,
      scopesHeader: null,
      body: { login: "fine" },
    }));
    expect(result.scopes).toBe("");
  });

  test("non-2xx throws with the API message, never the token", async () => {
    const probe = testGithubAuth(SECRET, async () => ({
      status: 401,
      scopesHeader: null,
      body: { message: "Bad credentials" },
    }));
    await expect(probe).rejects.toThrow(/401 Bad credentials/);
    await probe.catch((e: Error) => expect(e.message).not.toContain(SECRET));
  });

  test("forwards a GitHub Enterprise baseUrl to the transport", async () => {
    let seen: string | undefined;
    await testGithubAuth(
      SECRET,
      async ({ baseUrl }) => {
        seen = baseUrl;
        return { status: 200, scopesHeader: "repo", body: { login: "ent" } };
      },
      "https://github.example.com/api/v3",
    );
    expect(seen).toBe("https://github.example.com/api/v3");
  });
});

describe("ms-graph auth probe", () => {
  const input = { tenantId: "t-1", clientId: "c-1", clientSecret: SECRET };

  test("returns scope on a successful client-credentials exchange", async () => {
    const result = await testMsGraphAuth(input, async (got) => {
      expect(got.clientSecret).toBe(SECRET);
      return {
        status: 200,
        body: {
          access_token: "eyJ...",
          scope: "https://graph.microsoft.com/.default",
          expires_in: 3599,
        },
      };
    });
    expect(result.scope).toContain(".default");
    expect(result.expiresIn).toBe(3599);
  });

  test("invalid_client throws with error_description, never the secret", async () => {
    const probe = testMsGraphAuth(input, async () => ({
      status: 401,
      body: { error: "invalid_client", error_description: "secret expired" },
    }));
    await expect(probe).rejects.toThrow(/secret expired/);
    await probe.catch((e: Error) => expect(e.message).not.toContain(SECRET));
  });

  test("200 without access_token is still a failure", async () => {
    const probe = testMsGraphAuth(input, async () => ({ status: 200, body: {} }));
    await expect(probe).rejects.toThrow(/token exchange failed/);
  });
});

describe("google auth probe", () => {
  const input = { clientId: "c-1", refreshToken: SECRET };

  test("returns granted scope on a successful refresh exchange", async () => {
    const result = await testGoogleAuth(input, async (got) => {
      expect(got.refreshToken).toBe(SECRET);
      expect(got.clientSecret).toBeUndefined();
      return {
        status: 200,
        body: { access_token: "ya29...", scope: "drive.readonly gmail.readonly", expires_in: 3600 },
      };
    });
    expect(result.scope).toBe("drive.readonly gmail.readonly");
    expect(result.expiresIn).toBe(3600);
  });

  test("forwards an optional client secret when present", async () => {
    let seen: string | undefined;
    await testGoogleAuth({ ...input, clientSecret: "cs-1" }, async (got) => {
      seen = got.clientSecret;
      return { status: 200, body: { access_token: "ya29..." } };
    });
    expect(seen).toBe("cs-1");
  });

  test("invalid_grant throws, never the refresh token", async () => {
    const probe = testGoogleAuth(input, async () => ({
      status: 400,
      body: { error: "invalid_grant", error_description: "Token has been revoked." },
    }));
    await expect(probe).rejects.toThrow(/revoked/);
    await probe.catch((e: Error) => expect(e.message).not.toContain(SECRET));
  });
});

describe("box auth probe", () => {
  test("resolves login + name from users/me on 200", async () => {
    const result = await testBoxAuth(SECRET, async (token) => {
      expect(token).toBe(SECRET);
      return { status: 200, body: { login: "user@box.com", name: "Box User" } };
    });
    expect(result.login).toBe("user@box.com");
    expect(result.name).toBe("Box User");
  });

  test("401 throws with the Box message, never the token", async () => {
    const probe = testBoxAuth(SECRET, async () => ({
      status: 401,
      body: { message: "Unauthorized" },
    }));
    await expect(probe).rejects.toThrow(/401 Unauthorized/);
    await probe.catch((e: Error) => expect(e.message).not.toContain(SECRET));
  });
});
