/**
 * `suasor slack conversations` network-seam wiring (ADR-0011 / ADR-0013, #268).
 *
 * The existing tests/cli/slack.test.ts cover arg validation + the pure row
 * formatter only; the command's network orchestration — auth.test → enumerate
 * (users.conversations, with cursor paging + DM name resolution) → engagement
 * sort (search.messages) → render the config block — was untested. These drive
 * the whole command through the one seam every Slack leaf module shares: the
 * global `fetch` wrapped by `slackFetch` (ADR-0019). A token is supplied via the
 * `SUASOR_CONNECTOR_SLACK_TOKEN` env override so the keychain is never touched.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildCli } from "../../src/cli/index.ts";

/** A Slack endpoint stub: status + a JSON body + optional response headers. */
interface Stub {
  status?: number;
  headers?: Record<string, string>;
  body: unknown;
}

/** A queue/handler per Slack API path; the fake `fetch` routes on the URL. */
type Router = (url: string, params: URLSearchParams) => Stub;

let realFetch: typeof fetch;
let savedToken: string | undefined;

beforeEach(() => {
  realFetch = globalThis.fetch;
  savedToken = process.env.SUASOR_CONNECTOR_SLACK_TOKEN;
  process.env.SUASOR_CONNECTOR_SLACK_TOKEN = "xoxp-test-token";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedToken === undefined) delete process.env.SUASOR_CONNECTOR_SLACK_TOKEN;
  else process.env.SUASOR_CONNECTOR_SLACK_TOKEN = savedToken;
});

/** Install a fake global `fetch` that dispatches Slack API calls to `route`. */
function installFetch(route: Router): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const u = new URL(url);
    calls.push(u.pathname.replace("/api/", ""));
    const stub = route(url, u.searchParams);
    return new Response(JSON.stringify(stub.body), {
      status: stub.status ?? 200,
      headers: stub.headers ?? {},
    });
  }) as typeof fetch;
  return { calls };
}

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const cli = buildCli();
  const code = await cli.run(args, {
    stdin: process.stdin,
    stdout: {
      write: (s: string) => {
        out += s;
        return true;
      },
    } as NodeJS.WriteStream,
    stderr: {
      write: (s: string) => {
        err += s;
        return true;
      },
    } as NodeJS.WriteStream,
    env: process.env,
    colorDepth: 1,
  });
  return { code, out, err };
}

/** A successful `auth.test` body for a User Token (no bot_id → principal=user). */
const USER_AUTH = {
  ok: true,
  team: "Acme",
  team_id: "T123",
  user: "alice",
  user_id: "U001",
};
/** A Bot Token auth (bot_id present → principal=bot; engagement sort is N/A). */
const BOT_AUTH = { ...USER_AUTH, bot_id: "B999" };
/** An org-level (org-wide app) User Token — honours users.conversations team_id (#350). */
const ORG_AUTH = { ...USER_AUTH, is_enterprise_install: true };

describe("suasor slack conversations — network seam", () => {
  test("auth.test + users.conversations: lists channels and prints the config block", async () => {
    installFetch((url, params) => {
      if (url.includes("auth.test"))
        return { headers: { "x-oauth-scopes": "channels:read" }, body: USER_AUTH };
      if (url.includes("users.conversations")) {
        // Only the public type returns rows; the other three are empty.
        if (params.get("types") === "public_channel") {
          return {
            body: {
              ok: true,
              channels: [
                { id: "C001", name: "general", is_member: true },
                { id: "C002", name: "random", is_member: false },
              ],
            },
          };
        }
        return { body: { ok: true, channels: [] } };
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const { code, out } = await run(["slack", "conversations", "--types", "public"]);
    expect(code).toBe(0);
    // Both channels are surfaced, ids first (config wants ids, #158).
    expect(out).toContain("C001");
    expect(out).toContain("#general");
    expect(out).toContain("C002");
    // The paste-ready config block carries the resolved team id.
    expect(out).toContain("[connectors.slack]");
    expect(out).toContain('team = "T123"');
  });

  test("cursor paging: a next_cursor is followed until exhausted", async () => {
    let page = 0;
    const { calls } = installFetch((url) => {
      if (url.includes("auth.test"))
        return { headers: { "x-oauth-scopes": "channels:read" }, body: USER_AUTH };
      if (url.includes("users.conversations")) {
        if (url.includes("public_channel")) {
          page += 1;
          if (page === 1) {
            return {
              body: {
                ok: true,
                channels: [{ id: "C001", name: "alpha", is_member: true }],
                response_metadata: { next_cursor: "PAGE2" },
              },
            };
          }
          return { body: { ok: true, channels: [{ id: "C002", name: "beta", is_member: true }] } };
        }
        return { body: { ok: true, channels: [] } };
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const { code, out } = await run(["slack", "conversations", "--types", "public", "--json"]);
    expect(code).toBe(0);
    const report = JSON.parse(out) as { conversations: { id: string }[] };
    // Both pages were fetched + merged (the cursor was followed).
    expect(report.conversations.map((c) => c.id).sort()).toEqual(["C001", "C002"]);
    // Two users.conversations calls for the public type = the cursor was honoured.
    expect(calls.filter((c) => c === "users.conversations").length).toBe(2);
  });

  test("partial failure: a missing listing scope on one type self-reports, sweep continues", async () => {
    installFetch((url, params) => {
      if (url.includes("auth.test"))
        return { headers: { "x-oauth-scopes": "channels:read" }, body: USER_AUTH };
      if (url.includes("users.conversations")) {
        if (params.get("types") === "public_channel") {
          return {
            body: { ok: true, channels: [{ id: "C001", name: "general", is_member: true }] },
          };
        }
        // private fails on a missing scope; the other empties just return ok.
        if (params.get("types") === "private_channel") {
          return { body: { ok: false, error: "missing_scope", needed: "groups:read" } };
        }
        return { body: { ok: true, channels: [] } };
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const { code, out, err } = await run(["slack", "conversations", "--types", "public,private"]);
    // The sweep does not fail — public still lists, private self-reports.
    expect(code).toBe(0);
    expect(out).toContain("C001");
    expect(err).toContain("private not listed");
    expect(err).toContain("groups:read");
  });

  test("engagement sort (--sort=last_self_post): User Token orders by self-post recency", async () => {
    installFetch((url, params) => {
      if (url.includes("auth.test"))
        return { headers: { "x-oauth-scopes": "channels:read,search:read" }, body: USER_AUTH };
      if (url.includes("users.conversations")) {
        if (params.get("types") === "public_channel") {
          return {
            body: {
              ok: true,
              channels: [
                { id: "C_OLD", name: "old", is_member: true },
                { id: "C_NEW", name: "new", is_member: true },
              ],
            },
          };
        }
        return { body: { ok: true, channels: [] } };
      }
      if (url.includes("search.messages")) {
        // C_NEW has the most recent self-post → it must sort first.
        return {
          body: {
            ok: true,
            messages: {
              matches: [
                { ts: "100.0", channel: { id: "C_OLD" } },
                { ts: "900.0", channel: { id: "C_NEW" } },
              ],
              paging: { pages: 1, page: 1 },
            },
          },
        };
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const { code, out } = await run([
      "slack",
      "conversations",
      "--types",
      "public",
      "--sort",
      "last_self_post",
      "--json",
    ]);
    expect(code).toBe(0);
    const report = JSON.parse(out) as {
      conversations: { id: string; lastSelfPost: string | null }[];
    };
    // Engagement order: the channel with the newer self-post ts comes first.
    expect(report.conversations.map((c) => c.id)).toEqual(["C_NEW", "C_OLD"]);
    expect(report.conversations[0]?.lastSelfPost).toBe("900.0");
  });

  test("engagement sort degrades to N/A on a Bot Token (search.messages not called)", async () => {
    const { calls } = installFetch((url, params) => {
      if (url.includes("auth.test"))
        return { headers: { "x-oauth-scopes": "channels:read" }, body: BOT_AUTH };
      if (url.includes("users.conversations")) {
        if (params.get("types") === "public_channel") {
          return {
            body: { ok: true, channels: [{ id: "C001", name: "general", is_member: true }] },
          };
        }
        return { body: { ok: true, channels: [] } };
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const { code, err } = await run([
      "slack",
      "conversations",
      "--types",
      "public",
      "--sort",
      "last_self_post",
    ]);
    expect(code).toBe(0);
    // A Bot Token can't run from:me search → warns N/A and never calls search.
    expect(err).toContain("--sort=last_self_post is N/A");
    expect(calls.some((c) => c === "search.messages")).toBe(false);
  });

  test("--team-id on an org-level token scopes users.conversations by team_id, no warning (#350)", async () => {
    const seen: (string | null)[] = [];
    installFetch((url, params) => {
      if (url.includes("auth.test"))
        return { headers: { "x-oauth-scopes": "channels:read" }, body: ORG_AUTH };
      if (url.includes("users.conversations")) {
        seen.push(params.get("team_id"));
        if (params.get("types") === "public_channel") {
          return {
            body: { ok: true, channels: [{ id: "C001", name: "general", is_member: true }] },
          };
        }
        return { body: { ok: true, channels: [] } };
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const { code, out, err } = await run([
      "slack",
      "conversations",
      "--types",
      "public",
      "--team-id",
      "T555",
    ]);
    expect(code).toBe(0);
    expect(out).toContain("C001");
    // team_id threaded into the users.conversations request.
    expect(seen).toContain("T555");
    // An org-level token honours team_id → no ignored-flag warning.
    expect(err).not.toContain("--team-id is ignored");
  });

  test("--team-id on a workspace-level token warns it is ignored, still lists (#350)", async () => {
    installFetch((url, params) => {
      if (url.includes("auth.test"))
        return { headers: { "x-oauth-scopes": "channels:read" }, body: USER_AUTH };
      if (url.includes("users.conversations")) {
        if (params.get("types") === "public_channel") {
          return {
            body: { ok: true, channels: [{ id: "C001", name: "general", is_member: true }] },
          };
        }
        return { body: { ok: true, channels: [] } };
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const { code, out, err } = await run([
      "slack",
      "conversations",
      "--types",
      "public",
      "--team-id",
      "T555",
    ]);
    // The sweep still succeeds (Slack ignores team_id and lists the token's own
    // workspace); the mismatch is surfaced as a warning rather than silently.
    expect(code).toBe(0);
    expect(out).toContain("C001");
    expect(err).toContain("--team-id is ignored");
    expect(err).toContain("ADR-0014");
  });

  test("a non-scope auth.test failure exits 1 with the Slack error code (token never echoed)", async () => {
    installFetch((url) => {
      if (url.includes("auth.test")) return { body: { ok: false, error: "invalid_auth" } };
      throw new Error(`unexpected url: ${url}`);
    });

    const { code, out, err } = await run(["slack", "conversations", "--types", "public"]);
    expect(code).toBe(1);
    expect(err).toContain("invalid_auth");
    // The bearer token must never leak into output (NFR-PRV-4).
    expect(out).not.toContain("xoxp-test-token");
    expect(err).not.toContain("xoxp-test-token");
  });
});

describe("suasor slack auth test — network seam", () => {
  test("a valid token prints the principal, scopes, and a per-feature readiness block", async () => {
    installFetch((url) => {
      if (url.includes("auth.test")) {
        return { headers: { "x-oauth-scopes": "channels:read,channels:history" }, body: USER_AUTH };
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const { code, out } = await run(["slack", "auth", "test"]);
    expect(code).toBe(0);
    expect(out).toContain("alice");
    expect(out).toContain("Acme");
    expect(out).toContain("channels:read");
    // The readiness assessment is rendered (a 'features:' block).
    expect(out).toContain("features:");
  });

  test("--json emits the resolved identity + scopes + features (token never echoed)", async () => {
    installFetch((url) => {
      if (url.includes("auth.test")) {
        return { headers: { "x-oauth-scopes": "channels:read" }, body: USER_AUTH };
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const { code, out } = await run(["slack", "auth", "test", "--json"]);
    expect(code).toBe(0);
    const report = JSON.parse(out) as { teamId: string; scopes: string; features: unknown };
    expect(report.teamId).toBe("T123");
    expect(report.scopes).toContain("channels:read");
    expect(report.features).toBeDefined();
    expect(out).not.toContain("xoxp-test-token");
  });

  test("an invalid token exits 1 with the Slack error (no token leak)", async () => {
    installFetch((url) => {
      if (url.includes("auth.test")) return { body: { ok: false, error: "invalid_auth" } };
      throw new Error(`unexpected url: ${url}`);
    });

    const { code, out, err } = await run(["slack", "auth", "test"]);
    expect(code).toBe(1);
    expect(err).toContain("invalid_auth");
    expect(out).not.toContain("xoxp-test-token");
    expect(err).not.toContain("xoxp-test-token");
  });
});
