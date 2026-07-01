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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
let savedDir: string | undefined;
let dir: string;

beforeEach(() => {
  realFetch = globalThis.fetch;
  savedToken = process.env.SUASOR_CONNECTOR_SLACK_TOKEN;
  process.env.SUASOR_CONNECTOR_SLACK_TOKEN = "xoxp-test-token";
  // Isolate the config dir so `--workspace` resolution (Issue #371 theme 1) reads
  // an empty (flat) config — not the developer's real multi-workspace config,
  // which would flip these single-token sweeps into an ambiguity error.
  savedDir = process.env.SUASOR_CONFIG_DIR;
  dir = mkdtempSync(join(tmpdir(), "suasor-cli-convo-net-"));
  process.env.SUASOR_CONFIG_DIR = dir;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedToken === undefined) delete process.env.SUASOR_CONNECTOR_SLACK_TOKEN;
  else process.env.SUASOR_CONNECTOR_SLACK_TOKEN = savedToken;
  if (savedDir === undefined) delete process.env.SUASOR_CONFIG_DIR;
  else process.env.SUASOR_CONFIG_DIR = savedDir;
  rmSync(dir, { recursive: true, force: true });
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

  test("--team-id + --json on a workspace-level token warns and does not mis-tag rows (#350)", async () => {
    const seen: (string | null)[] = [];
    installFetch((url, params) => {
      if (url.includes("auth.test"))
        return { headers: { "x-oauth-scopes": "channels:read" }, body: USER_AUTH };
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
      "--json",
    ]);
    expect(code).toBe(0);
    // The warning reaches --json users too (it goes to stderr, stdout stays clean JSON).
    expect(err).toContain("--team-id is ignored");
    // team_id is NOT sent for a workspace-level token (Slack would ignore it),
    // so rows are not tagged with a workspace Slack never honoured.
    expect(seen.every((t) => t === null)).toBe(true);
    const report = JSON.parse(out) as { conversations: { id: string; teamId?: string }[] };
    expect(report.conversations.every((c) => c.teamId === undefined)).toBe(true);
  });

  test("org-level token with no --team-id auto-enumerates workspaces and sweeps each (#350)", async () => {
    const seenTeamIds: (string | null)[] = [];
    const { calls } = installFetch((url, params) => {
      if (url.includes("auth.test"))
        return { headers: { "x-oauth-scopes": "channels:read" }, body: ORG_AUTH };
      if (url.includes("auth.teams.list")) {
        return {
          body: {
            ok: true,
            teams: [
              { id: "T01", name: "Acme" },
              { id: "T02", name: "Beta Co" },
            ],
          },
        };
      }
      if (url.includes("users.conversations")) {
        seenTeamIds.push(params.get("team_id"));
        if (params.get("types") === "public_channel") {
          const team = params.get("team_id");
          return {
            body: {
              ok: true,
              channels: [{ id: team === "T01" ? "C_A" : "C_B", name: "general", is_member: true }],
            },
          };
        }
        return { body: { ok: true, channels: [] } };
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const { code, out } = await run(["slack", "conversations", "--types", "public"]);
    expect(code).toBe(0);
    // auth.teams.list was consulted and both workspaces were swept by team_id.
    expect(calls).toContain("auth.teams.list");
    expect(seenTeamIds).toContain("T01");
    expect(seenTeamIds).toContain("T02");
    // Both workspaces' channels are surfaced, grouped with per-workspace blocks.
    expect(out).toContain("across 2 workspace(s)");
    expect(out).toContain("C_A");
    expect(out).toContain("C_B");
    expect(out).toContain("[connectors.slack.workspaces.acme]");
    expect(out).toContain('team = "T01"');
    expect(out).toContain("[connectors.slack.workspaces.beta-co]");
    expect(out).toContain('team = "T02"');
  });

  test("multi-workspace --json adds a workspaces grouping and tags rows by team (#350)", async () => {
    installFetch((url, params) => {
      if (url.includes("auth.test"))
        return { headers: { "x-oauth-scopes": "channels:read" }, body: ORG_AUTH };
      if (url.includes("auth.teams.list")) {
        return {
          body: {
            ok: true,
            teams: [
              { id: "T01", name: "Acme" },
              { id: "T02", name: "Beta" },
            ],
          },
        };
      }
      if (url.includes("users.conversations")) {
        if (params.get("types") === "public_channel") {
          const team = params.get("team_id");
          return {
            body: {
              ok: true,
              channels: [{ id: team === "T01" ? "C_A" : "C_B", name: "general", is_member: true }],
            },
          };
        }
        return { body: { ok: true, channels: [] } };
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const { code, out } = await run(["slack", "conversations", "--types", "public", "--json"]);
    expect(code).toBe(0);
    const report = JSON.parse(out) as {
      conversations: { id: string; teamId?: string }[];
      workspaces?: { id: string; name: string; alias?: string }[];
    };
    expect(report.workspaces?.map((w) => w.id).sort()).toEqual(["T01", "T02"]);
    const byId = Object.fromEntries(report.conversations.map((c) => [c.id, c.teamId]));
    expect(byId.C_A).toBe("T01");
    expect(byId.C_B).toBe("T02");
  });

  test("a channel shared across workspaces is de-duplicated + marked in the listing (ADR-0038)", async () => {
    installFetch((url, params) => {
      if (url.includes("auth.test"))
        return { headers: { "x-oauth-scopes": "channels:read" }, body: ORG_AUTH };
      if (url.includes("auth.teams.list")) {
        return {
          body: {
            ok: true,
            teams: [
              { id: "T01", name: "Acme" },
              { id: "T02", name: "Beta" },
            ],
          },
        };
      }
      if (url.includes("users.conversations")) {
        if (params.get("types") === "public_channel") {
          const team = params.get("team_id");
          // C_SHARED (same global id) is listed under BOTH workspaces; each also
          // has one workspace-private channel.
          return {
            body: {
              ok: true,
              channels: [
                { id: "C_SHARED", name: "cross", is_member: true },
                { id: team === "T01" ? "C_A" : "C_B", name: "solo", is_member: true },
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
    // The shared channel's listing row appears exactly once (de-duplicated), not
    // once per workspace — identified by the "(shared across …)" row marker.
    const sharedRows = out
      .split("\n")
      .filter((l) => l.includes("C_SHARED") && l.includes("(shared across ["));
    expect(sharedRows).toHaveLength(1);
    // …and it is marked as shared across the aliases it spans.
    expect(out).toContain("(shared across [acme, beta])");
    // Owner = smallest alias = "acme": real entry there, comment under beta.
    expect(out).toContain('"C_SHARED",  # #cross');
    expect(out).toContain("# C_SHARED shared, owned by acme");
    // Both workspace-private channels still surface untouched.
    expect(out).toContain("C_A");
    expect(out).toContain("C_B");
  });

  test("multi-workspace --json adds sharedAcross for shared channels, omits it otherwise (ADR-0038)", async () => {
    installFetch((url, params) => {
      if (url.includes("auth.test"))
        return { headers: { "x-oauth-scopes": "channels:read" }, body: ORG_AUTH };
      if (url.includes("auth.teams.list")) {
        return {
          body: {
            ok: true,
            teams: [
              { id: "T01", name: "Acme" },
              { id: "T02", name: "Beta" },
            ],
          },
        };
      }
      if (url.includes("users.conversations")) {
        if (params.get("types") === "public_channel") {
          const team = params.get("team_id");
          return {
            body: {
              ok: true,
              channels: [
                { id: "C_SHARED", name: "cross", is_member: true },
                { id: team === "T01" ? "C_A" : "C_B", name: "solo", is_member: true },
              ],
            },
          };
        }
        return { body: { ok: true, channels: [] } };
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const { code, out } = await run(["slack", "conversations", "--types", "public", "--json"]);
    expect(code).toBe(0);
    const report = JSON.parse(out) as {
      conversations: { id: string; sharedAcross?: string[] }[];
    };
    const byId = Object.fromEntries(report.conversations.map((c) => [c.id, c]));
    // The shared channel appears once, tagged with the aliases it spans (ascending).
    expect(report.conversations.filter((c) => c.id === "C_SHARED")).toHaveLength(1);
    expect(byId.C_SHARED?.sharedAcross).toEqual(["acme", "beta"]);
    // Non-shared channels do not carry the additive field (back-compatible shape).
    expect(byId.C_A?.sharedAcross).toBeUndefined();
    expect(byId.C_B?.sharedAcross).toBeUndefined();
  });

  test("single-workspace --json has no sharedAcross field (back-compatible, ADR-0038)", async () => {
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

    const { code, out } = await run(["slack", "conversations", "--types", "public", "--json"]);
    expect(code).toBe(0);
    // The single-workspace shape is unchanged — no sharedAcross key at all.
    expect(out).not.toContain("sharedAcross");
  });

  test("org-level token falls back to a single sweep when auth.teams.list is unavailable (#350)", async () => {
    const { calls } = installFetch((url, params) => {
      if (url.includes("auth.test"))
        return { headers: { "x-oauth-scopes": "channels:read" }, body: ORG_AUTH };
      if (url.includes("auth.teams.list"))
        return { body: { ok: false, error: "enterprise_is_restricted" } };
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

    const { code, out } = await run(["slack", "conversations", "--types", "public"]);
    expect(code).toBe(0);
    // Enumeration was attempted but returned nothing usable → single flat block.
    expect(calls).toContain("auth.teams.list");
    expect(out).toContain("C001");
    expect(out).toContain("[connectors.slack]");
    expect(out).not.toContain("across");
    expect(out).not.toContain("workspaces.");
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
    // The resolved user_id is surfaced with a self_user_id copy hint (Issue #371
    // theme 2) — the value the operator pastes so demand detects their @mentions.
    expect(out).toContain("user_id: U001");
    expect(out).toContain('self_user_id = "U001"');
    expect(out).toContain("[connectors.slack]");
  });

  test("names the workspace section when --workspace is given (theme 2)", async () => {
    installFetch((url) => {
      if (url.includes("auth.test")) {
        return { headers: { "x-oauth-scopes": "channels:read" }, body: USER_AUTH };
      }
      throw new Error(`unexpected url: ${url}`);
    });
    // The acme workspace resolves the `acme:token` secret — supply it via its own
    // env override so the lookup succeeds.
    process.env.SUASOR_CONNECTOR_SLACK_ACME_TOKEN = "xoxp-acme-token";
    try {
      // --workspace is explicit, so it wins regardless of config shape; the
      // self_user_id hint points at that workspace's sub-section.
      const { code, out } = await run(["slack", "auth", "test", "--workspace", "acme"]);
      expect(code).toBe(0);
      expect(out).toContain('self_user_id = "U001"');
      expect(out).toContain("[connectors.slack.workspaces.acme]");
    } finally {
      delete process.env.SUASOR_CONNECTOR_SLACK_ACME_TOKEN;
    }
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

describe("suasor slack conversations --new — drift diff (ADR-0039)", () => {
  /** Write a flat [connectors.slack] config with the given channel ids. */
  function writeChannels(channels: string[]): void {
    const arr = channels.map((c) => `"${c}"`).join(", ");
    writeFileSync(join(dir, "config.toml"), `[connectors.slack]\nchannels = [${arr}]\n`);
  }

  test("shows only member conversations not in config + a paste-ready block", async () => {
    writeChannels(["C001", "CGONE"]);
    installFetch((url, params) => {
      if (url.includes("auth.test"))
        return { headers: { "x-oauth-scopes": "channels:read" }, body: USER_AUTH };
      if (url.includes("users.conversations")) {
        if (params.get("types") === "public_channel") {
          return {
            body: {
              ok: true,
              channels: [
                { id: "C001", name: "general", is_member: true }, // already configured
                { id: "C002", name: "random", is_member: true }, // new
                { id: "C003", name: "lurk", is_member: false }, // unjoined → not suggested
              ],
            },
          };
        }
        return { body: { ok: true, channels: [] } };
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const { code, out, err } = await run(["slack", "conversations", "--new"]);
    expect(code).toBe(0);
    // Only the new member channel is surfaced; the configured + unjoined ones are not.
    expect(out).toContain("C002");
    expect(out).not.toContain("C001");
    expect(out).not.toContain("C003");
    // Paste-ready block for the new channel(s).
    expect(out).toContain("[connectors.slack]");
    expect(out).toContain('team = "T123"');
    // The configured-but-unreachable channel is surfaced as a warn (not removed).
    expect(err).toContain("no longer reachable");
    expect(err).toContain("CGONE");
  });

  test("--new --json emits { new, removed }; the full-listing --json shape is untouched", async () => {
    writeChannels(["C001", "CGONE"]);
    installFetch((url, params) => {
      if (url.includes("auth.test"))
        return { headers: { "x-oauth-scopes": "channels:read" }, body: USER_AUTH };
      if (url.includes("users.conversations")) {
        if (params.get("types") === "public_channel") {
          return {
            body: {
              ok: true,
              channels: [
                { id: "C001", name: "general", is_member: true },
                { id: "C002", name: "random", is_member: true },
              ],
            },
          };
        }
        return { body: { ok: true, channels: [] } };
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const { code, out } = await run(["slack", "conversations", "--new", "--json"]);
    expect(code).toBe(0);
    const report = JSON.parse(out) as {
      new: { id: string }[];
      removed: string[];
      conversations?: unknown;
    };
    expect(report.new.map((c) => c.id)).toEqual(["C002"]);
    expect(report.removed).toEqual(["CGONE"]);
    // The new shape does not carry the full-listing `conversations` key (back-compat).
    expect(report.conversations).toBeUndefined();
  });

  test("defaults its sweep to public+private; a configured DM is not falsely 'removed'", async () => {
    // Configure a DM id; the default sweep never fetches `im`, so the DM must not
    // be reported as removed just because it was not swept (ADR-0039).
    writeChannels(["D_DM"]);
    const seenTypes: string[] = [];
    installFetch((url, params) => {
      if (url.includes("auth.test"))
        return { headers: { "x-oauth-scopes": "channels:read" }, body: USER_AUTH };
      if (url.includes("users.conversations")) {
        const t = params.get("types");
        if (t) seenTypes.push(t);
        return { body: { ok: true, channels: [] } };
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const { code, err } = await run(["slack", "conversations", "--new"]);
    expect(code).toBe(0);
    // Only public + private are swept by default (DMs/group-DMs are noise).
    expect(seenTypes).toContain("public_channel");
    expect(seenTypes).toContain("private_channel");
    expect(seenTypes).not.toContain("im");
    expect(seenTypes).not.toContain("mpim");
    // The unswept configured DM is not surfaced as unreachable.
    expect(err).not.toContain("no longer reachable");
  });

  test("multi-workspace config emits a [connectors.slack.workspaces.<alias>] fragment", async () => {
    // A named-workspace config discards the flat `channels` (resolveWorkspaces), so
    // the paste-ready block must target the workspace sub-section sync ingests, not
    // a flat [connectors.slack] block that would be silently ignored.
    writeFileSync(
      join(dir, "config.toml"),
      '[connectors.slack.workspaces.acme]\nteam = "T123"\nchannels = ["C001"]\n',
    );
    process.env.SUASOR_CONNECTOR_SLACK_ACME_TOKEN = "xoxp-acme-token";
    try {
      installFetch((url, params) => {
        if (url.includes("auth.test"))
          return { headers: { "x-oauth-scopes": "channels:read" }, body: USER_AUTH };
        if (url.includes("users.conversations")) {
          if (params.get("types") === "public_channel") {
            return {
              body: {
                ok: true,
                channels: [
                  { id: "C001", name: "general", is_member: true }, // configured
                  { id: "C002", name: "random", is_member: true }, // new
                ],
              },
            };
          }
          return { body: { ok: true, channels: [] } };
        }
        throw new Error(`unexpected url: ${url}`);
      });

      const { code, out } = await run(["slack", "conversations", "--new", "--workspace", "acme"]);
      expect(code).toBe(0);
      expect(out).toContain("C002");
      // The fragment targets the workspace sub-section (flat renderConfigBlock
      // never emits a workspaces.<alias> table), so sync actually ingests it.
      expect(out).toContain("[connectors.slack.workspaces.acme]");
    } finally {
      delete process.env.SUASOR_CONNECTOR_SLACK_ACME_TOKEN;
    }
  });
});
