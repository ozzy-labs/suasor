/**
 * Per-connector `auth test` probe unit tests (Issue #85). Each probe is a
 * `fetch`-only round-trip with an injectable transport, so these exercise
 * success / failure / scope reporting with no real network and assert the token
 * is never leaked into a thrown error message.
 */
import { describe, expect, test } from "bun:test";
import {
  configuredResources,
  featureReadiness,
  githubFeatures,
  googleFeatures,
  msGraphFeatures,
} from "../../src/connectors/auth-specs.ts";
import { testBoxAuth } from "../../src/connectors/box/auth.ts";
import { testGithubAuth } from "../../src/connectors/github/auth.ts";
import { testGoogleAuth } from "../../src/connectors/google/auth.ts";
import {
  basicCredential,
  buildJiraAuth,
  makeDefaultTransport as makeJiraAuthTransport,
  SELF_HOSTED_API_BASE,
  testJiraAuth,
} from "../../src/connectors/jira/auth.ts";
import { DEFAULT_API_BASE } from "../../src/connectors/jira/client.ts";
import { testMsGraphAuth } from "../../src/connectors/ms-graph/auth.ts";
import { testNotionAuth } from "../../src/connectors/notion/auth.ts";

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

/**
 * Per-feature readiness assessment (Issue #194). The generic `auth test`
 * `features:` block — generalized from Slack's scope capability model to the
 * other token-bearing connectors. These exercise the pure builders directly
 * (READY / MISSING / N/A) so the verdicts are asserted with no network.
 */
describe("featureReadiness (scope substring model)", () => {
  test("READY when a needle is a substring of the granted scopes", () => {
    const r = featureReadiness({ label: "x", scopeNeedles: ["drive"] }, "openid drive.readonly");
    expect(r.status).toBe("READY");
  });

  test("matches case-insensitively", () => {
    const r = featureReadiness({ label: "x", scopeNeedles: ["Mail.Read"] }, "MAIL.READ offline");
    expect(r.status).toBe("READY");
  });

  test("MISSING lists the alternatives when no needle matches", () => {
    const r = featureReadiness({ label: "x", scopeNeedles: ["a", "b"] }, "c d");
    expect(r.status).toBe("MISSING a | b");
  });

  test("N/A when scopes are not enumerated (null)", () => {
    const r = featureReadiness({ label: "x", scopeNeedles: ["a"] }, null);
    expect(r.status).toBe("N/A (scopes not enumerated)");
  });

  test("no needles → always READY (no scope gate)", () => {
    expect(featureReadiness({ label: "x", scopeNeedles: [] }, null).status).toBe("READY");
  });
});

describe("configuredResources", () => {
  test("reads a string array from the slice", () => {
    const got = configuredResources({ resources: ["mail", "calendar", 7, null] });
    expect([...got].sort()).toEqual(["calendar", "mail"]);
  });

  test("empty set when resources is absent or not an array", () => {
    expect(configuredResources({}).size).toBe(0);
    expect(configuredResources({ resources: "mail" }).size).toBe(0);
  });
});

describe("github features", () => {
  test("issue/PR row READY with a classic `repo` scope", () => {
    const f = githubFeatures("repo, read:org", "off");
    expect(f).toHaveLength(1);
    expect(f[0]).toEqual({ label: "issue / pull request read", status: "READY" });
  });

  test("issue/PR row MISSING when no repo-bearing scope is granted", () => {
    const f = githubFeatures("read:user", "off");
    expect(f[0]?.status).toBe("MISSING repo");
  });

  test("fine-grained PAT (null scopes) → N/A, not a false MISSING", () => {
    const f = githubFeatures(null, "off");
    expect(f[0]?.status).toBe("N/A (scopes not enumerated)");
  });

  test("notifications row appears only when configured, READY via `notifications`", () => {
    const off = githubFeatures("repo", "off");
    expect(off).toHaveLength(1);
    const on = githubFeatures("repo, notifications", "all");
    expect(on).toHaveLength(2);
    expect(on[1]).toEqual({ label: "notifications stream", status: "READY" });
  });

  test("notifications row MISSING when neither `notifications` nor `repo` granted", () => {
    const f = githubFeatures("read:org", "repos");
    expect(f[1]?.status).toBe("MISSING notifications | repo");
  });
});

describe("ms-graph features", () => {
  test("one N/A row per configured resource (.default not enumerated)", () => {
    const f = msGraphFeatures(new Set(["mail", "calendar"]));
    expect(f).toEqual([
      { label: "mail read (Mail.Read)", status: "N/A (scopes not enumerated)" },
      { label: "calendar read (Calendars.Read)", status: "N/A (scopes not enumerated)" },
    ]);
  });

  test("emits rows in the SSOT declaration order, not config order", () => {
    const f = msGraphFeatures(new Set(["teams", "mail"]));
    expect(f.map((r) => r.label)).toEqual([
      "mail read (Mail.Read)",
      "teams read (Channel/Chat.Read.All)",
    ]);
  });

  test("no resources configured → single explanatory row", () => {
    expect(msGraphFeatures(new Set())).toEqual([
      { label: "ingestion", status: "N/A (no resources configured)" },
    ]);
  });

  test("unknown resource names are ignored (forward-compatible)", () => {
    expect(msGraphFeatures(new Set(["sharepoint"]))).toEqual([]);
  });
});

describe("google features", () => {
  test("READY per resource whose scope substring is granted", () => {
    const scopes = "https://www.googleapis.com/auth/drive.readonly https://mail.google.com/";
    const f = googleFeatures(new Set(["drive", "gmail", "calendar"]), scopes);
    expect(f).toEqual([
      { label: "Drive read", status: "READY" },
      { label: "Gmail read", status: "READY" },
      { label: "Calendar read", status: "MISSING calendar" },
    ]);
  });

  test("gmail matches either `gmail` or `mail.google.com`", () => {
    const g1 = googleFeatures(new Set(["gmail"]), "https://www.googleapis.com/auth/gmail.readonly");
    expect(g1[0]?.status).toBe("READY");
    const g2 = googleFeatures(new Set(["gmail"]), "https://mail.google.com/");
    expect(g2[0]?.status).toBe("READY");
  });

  test("null scopes → N/A per resource", () => {
    const f = googleFeatures(new Set(["drive"]), null);
    expect(f[0]?.status).toBe("N/A (scopes not enumerated)");
  });

  test("no resources configured → single explanatory row", () => {
    expect(googleFeatures(new Set(), "drive")).toEqual([
      { label: "ingestion", status: "N/A (no resources configured)" },
    ]);
  });
});

describe("notion auth probe", () => {
  test("resolves the bot name + workspace from a 200 users/me", async () => {
    const result = await testNotionAuth(SECRET, async (token) => {
      expect(token).toBe(SECRET);
      return {
        status: 200,
        body: { name: "Suasor Bot", bot: { workspace_name: "Acme" } },
      };
    });
    expect(result.name).toBe("Suasor Bot");
    expect(result.workspaceName).toBe("Acme");
  });

  test("non-2xx throws with the Notion message, never the token", async () => {
    const probe = testNotionAuth(SECRET, async () => ({
      status: 401,
      body: { message: "API token is invalid." },
    }));
    await expect(probe).rejects.toThrow(/401 API token is invalid/);
    await probe.catch((e: Error) => expect(e.message).not.toContain(SECRET));
  });

  test("missing bot.workspace_name degrades gracefully", async () => {
    const result = await testNotionAuth(SECRET, async () => ({
      status: 200,
      body: { name: "Bot only" },
    }));
    expect(result.name).toBe("Bot only");
    expect(result.workspaceName).toBe("");
  });
});

describe("jira auth — credential building", () => {
  test("basic builds an email:token Basic header on the Cloud REST base", () => {
    const auth = buildJiraAuth({
      scheme: "basic",
      host: "example.atlassian.net",
      email: "me@example.com",
      token: SECRET,
    });
    expect(auth.authorization).toBe(basicCredential("me@example.com", SECRET));
    expect(auth.apiBase).toBe(DEFAULT_API_BASE);
    expect(auth.host).toBe("example.atlassian.net");
  });

  test("bearer builds a PAT header on the self-hosted REST base (no email)", () => {
    const auth = buildJiraAuth({ scheme: "bearer", host: "jira.internal", token: SECRET });
    expect(auth.authorization).toBe(`Bearer ${SECRET}`);
    expect(auth.apiBase).toBe(SELF_HOSTED_API_BASE);
  });

  test("basic without an email throws (Cloud needs email:token)", () => {
    expect(() => buildJiraAuth({ scheme: "basic", host: "h", token: SECRET })).toThrow(
      /email is required/,
    );
  });

  test("a missing host throws", () => {
    expect(() => buildJiraAuth({ scheme: "bearer", host: "", token: SECRET })).toThrow(
      /host is required/,
    );
  });
});

describe("jira auth probe", () => {
  const auth = buildJiraAuth({
    scheme: "basic",
    host: "example.atlassian.net",
    email: "me@example.com",
    token: SECRET,
  });

  test("resolves the account display name + email from a 200 myself", async () => {
    const result = await testJiraAuth(auth, async (got) => {
      expect(got.authorization).toContain("Basic");
      return { status: 200, body: { displayName: "Alice", emailAddress: "alice@example.com" } };
    });
    expect(result.displayName).toBe("Alice");
    expect(result.email).toBe("alice@example.com");
  });

  test("non-2xx throws with the Jira message, never the credential", async () => {
    const probe = testJiraAuth(auth, async () => ({
      status: 401,
      body: { errorMessages: ["Client must be authenticated to access this resource."] },
    }));
    await expect(probe).rejects.toThrow(/401 Client must be authenticated/);
    await probe.catch((e: Error) => expect(e.message).not.toContain(SECRET));
  });

  test("default transport calls <apiBase>/myself with the Authorization header", async () => {
    let seenUrl = "";
    const transport = makeJiraAuthTransport({
      fetchImpl: async (url, init) => {
        seenUrl = url;
        expect((init?.headers as Record<string, string>).Authorization).toBe(auth.authorization);
        return new Response(JSON.stringify({ displayName: "Z" }), { status: 200 });
      },
    });
    const { status, body } = await transport(auth);
    expect(status).toBe(200);
    expect(seenUrl).toBe("https://example.atlassian.net/rest/api/3/myself");
    expect(body.displayName).toBe("Z");
  });
});
