/**
 * `suasor jira projects` discovery CLI wiring + the DISCOVERY_SPECS probe
 * (ADR-0030). No network: the no-credential path short-circuits before any probe;
 * the jira probe is exercised directly with an injected secret resolver + a fake
 * transport via the leaf module.
 */
import { describe, expect, test } from "bun:test";
import { buildCli } from "../../src/cli/index.ts";
import { DISCOVERY_SPECS } from "../../src/connectors/discovery-specs.ts";
import { buildJiraAuth } from "../../src/connectors/jira/auth.ts";
import {
  type JiraProjectsTransport,
  listProjects,
  makeDefaultTransport as makeProjectsTransport,
  renderConfigBlock,
} from "../../src/connectors/jira/projects.ts";

const SECRET_ENVS = ["SUASOR_CONNECTOR_JIRA_TOKEN"];

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const saved = SECRET_ENVS.map((k) => [k, process.env[k]] as const);
  for (const k of SECRET_ENVS) delete process.env[k];
  let out = "";
  let err = "";
  const cli = buildCli();
  try {
    const code = await cli.run(args, {
      stdin: (async function* () {})() as unknown as NodeJS.ReadStream,
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
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const AUTH = buildJiraAuth({
  scheme: "basic",
  host: "example.atlassian.net",
  email: "me@example.com",
  token: "tok",
});

/** A fake `project/search` transport keyed by startAt for pagination. */
function searchTransport(
  pages: { projects: { key: string; name: string }[]; total?: number }[],
): JiraProjectsTransport {
  let idx = 0;
  return async () => {
    const page = pages[idx] ?? { projects: [] };
    const total = page.total ?? pages.reduce((n, p) => n + p.projects.length, 0);
    idx += 1;
    return {
      status: 200,
      body: {
        total,
        values: page.projects.map((p) => ({ key: p.key, name: p.name })),
      },
    };
  };
}

describe("suasor jira projects — CLI wiring (no network)", () => {
  test("registers `jira projects` in --help", async () => {
    const { code, out } = await run(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("jira projects");
  });

  test("jira projects without a token exits 1 with onboarding guidance", async () => {
    const { code, err } = await run(["jira", "projects"]);
    expect(code).toBe(1);
    expect(err).toContain("no jira token configured");
    expect(err).toContain("jira auth set");
  });
});

describe("DISCOVERY_SPECS.jira.discover probe (injected secret)", () => {
  test("throws the no-token error when the secret is absent", async () => {
    await expect(
      DISCOVERY_SPECS.jira?.discover({ secret: async () => null, config: { host: "h" } }),
    ).rejects.toThrow(/no jira token configured/);
  });

  test("requires host in config", async () => {
    await expect(
      DISCOVERY_SPECS.jira?.discover({ secret: async () => "tok", config: {} }),
    ).rejects.toThrow(/host is required/);
  });
});

describe("jira projects leaf — listProjects / renderConfigBlock", () => {
  test("enumerates projects sorted a-z by key", async () => {
    const transport = searchTransport([
      {
        projects: [
          { key: "ZET", name: "Zeta" },
          { key: "ALP", name: "Alpha" },
          { key: "MID", name: "Mid" },
        ],
      },
    ]);
    const result = await listProjects(AUTH, { transport });
    expect(result.projects.map((p) => p.key)).toEqual(["ALP", "MID", "ZET"]);
  });

  test("paginates via startAt until total is reached", async () => {
    const transport = searchTransport([
      { projects: [{ key: "A", name: "Alpha" }], total: 2 },
      { projects: [{ key: "B", name: "Beta" }], total: 2 },
    ]);
    const result = await listProjects(AUTH, { transport });
    expect(result.projects.map((p) => p.key).sort()).toEqual(["A", "B"]);
  });

  test("filters by key or name (case-insensitive)", async () => {
    const transport = searchTransport([
      {
        projects: [
          { key: "REP", name: "Reports" },
          { key: "INV", name: "Invoices" },
        ],
      },
    ]);
    const result = await listProjects(AUTH, { transport, filter: "report" });
    expect(result.projects.map((p) => p.name)).toEqual(["Reports"]);
  });

  test("throws with the HTTP status on a non-2xx (credential never echoed)", async () => {
    const secretAuth = buildJiraAuth({
      scheme: "basic",
      host: "example.atlassian.net",
      email: "me@example.com",
      token: "secret-token",
    });
    const transport: JiraProjectsTransport = async () => ({
      status: 404,
      body: { errorMessages: ["Not Found"] },
    });
    await expect(listProjects(secretAuth, { transport })).rejects.toThrow(
      /jira GET \/project\/search failed: 404 Not Found/,
    );
    await expect(listProjects(secretAuth, { transport })).rejects.not.toThrow(/secret-token/);
  });

  test("renderConfigBlock emits a paste-ready [connectors.jira] projects array", async () => {
    const block = renderConfigBlock(
      {
        projects: [
          { key: "ALP", name: "Alpha" },
          { key: "BET", name: "Beta" },
        ],
      },
      "example.atlassian.net",
    ).join("\n");
    expect(block).toContain("[connectors.jira]");
    expect(block).toContain("enabled = true");
    expect(block).toContain('host = "example.atlassian.net"');
    expect(block).toContain('"ALP",  # Alpha');
    expect(block).toContain('"BET",  # Beta');
  });

  test("renderConfigBlock emits an empty array when nothing is discovered", async () => {
    const block = renderConfigBlock({ projects: [] }).join("\n");
    expect(block).toContain("projects = []");
  });

  test("default transport calls /project/search with startAt + Authorization", async () => {
    let seenUrl = "";
    const transport = makeProjectsTransport({
      fetchImpl: async (url, init) => {
        seenUrl = url;
        expect((init?.headers as Record<string, string>).Authorization).toBe(AUTH.authorization);
        return new Response(JSON.stringify({ total: 0, values: [] }), { status: 200 });
      },
    });
    const { status } = await transport({ auth: AUTH, startAt: 0 });
    expect(status).toBe(200);
    expect(seenUrl).toContain("https://example.atlassian.net/rest/api/3/project/search?");
    expect(seenUrl).toContain("startAt=0");
  });
});
