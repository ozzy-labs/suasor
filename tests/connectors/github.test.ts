import { describe, expect, test } from "bun:test";
import type { SourceRecord, SyncContext } from "../../src/connectors/contract.ts";
import {
  createGithubConnector,
  GithubConnectorConfig,
  type OctokitLike,
} from "../../src/connectors/github.ts";

/** Build a fake Octokit whose paginate.iterator yields the given pages. */
function fakeOctokit(pages: Array<{ data: unknown[] }>): {
  octokit: OctokitLike;
  calls: Array<{ route: string; params: Record<string, unknown> }>;
} {
  const calls: Array<{ route: string; params: Record<string, unknown> }> = [];
  const octokit: OctokitLike = {
    paginate: {
      iterator(route, params) {
        calls.push({ route, params });
        return (async function* () {
          for (const page of pages) yield page as { data: never[] };
        })();
      },
    },
  };
  return { octokit, calls };
}

function ctx(overrides: Partial<SyncContext> = {}): SyncContext {
  return {
    cursor: null,
    secret: async (name) => (name === "token" ? "tok" : null),
    ...overrides,
  };
}

async function collect(it: AsyncIterable<SourceRecord>): Promise<SourceRecord[]> {
  const out: SourceRecord[] = [];
  for await (const r of it) out.push(r);
  return out;
}

const issue = {
  number: 1,
  title: "Fix the bug",
  body: "steps to reproduce",
  state: "open",
  html_url: "https://github.com/o/r/issues/1",
  updated_at: "2026-06-10T00:00:00Z",
  user: { login: "alice" },
};
const pr = {
  number: 2,
  title: "Add feature",
  body: null,
  state: "open",
  html_url: "https://github.com/o/r/pull/2",
  updated_at: "2026-06-12T00:00:00Z",
  pull_request: { url: "..." },
  user: { login: "bob" },
};

describe("GithubConnectorConfig", () => {
  test("rejects malformed repo entries", () => {
    expect(() => GithubConnectorConfig.parse({ repos: ["not-a-repo"] })).toThrow();
  });
  test("defaults: empty repos, state all", () => {
    const c = GithubConnectorConfig.parse({});
    expect(c.repos).toEqual([]);
    expect(c.state).toBe("all");
  });
});

describe("GitHub connector — record mapping (ADR-0007 identity)", () => {
  test("maps issues and PRs to distinct source_types and external ids", async () => {
    const { octokit } = fakeOctokit([{ data: [issue, pr] }]);
    const connector = createGithubConnector({ repos: ["o/r"] }, { octokitFactory: () => octokit });
    const records = await collect(connector.sync(ctx()));
    expect(records).toHaveLength(2);

    const issueRec = records.find((r) => r.sourceType === "github_issue");
    expect(issueRec?.externalId).toBe("gh:o/r:issue:1");
    expect(issueRec?.body).toBe("Fix the bug\n\nsteps to reproduce");
    expect(issueRec?.meta).toMatchObject({ repo: "o/r", number: 1, author: "alice" });

    const prRec = records.find((r) => r.sourceType === "github_pull_request");
    expect(prRec?.externalId).toBe("gh:o/r:pull_request:2");
    // PR with null body → body is just the title.
    expect(prRec?.body).toBe("Add feature");
  });
});

describe("GitHub connector — delta cursor (FR-ING-3)", () => {
  test("passes the cursor as `since` and returns the max updated_at", async () => {
    const { octokit, calls } = fakeOctokit([{ data: [issue, pr] }]);
    const connector = createGithubConnector({ repos: ["o/r"] }, { octokitFactory: () => octokit });
    await collect(connector.sync(ctx({ cursor: "2026-06-01T00:00:00Z" })));
    expect(calls[0]?.params.since).toBe("2026-06-01T00:00:00Z");

    const result = await connector.finalize?.();
    // pr.updated_at (2026-06-12) is the most recent.
    expect(result?.cursor).toBe("2026-06-12T00:00:00Z");
  });

  test("first run omits `since`", async () => {
    const { octokit, calls } = fakeOctokit([{ data: [issue] }]);
    const connector = createGithubConnector({ repos: ["o/r"] }, { octokitFactory: () => octokit });
    await collect(connector.sync(ctx()));
    expect(calls[0]?.params.since).toBeUndefined();
  });
});

describe("GitHub connector — guards", () => {
  test("throws when no token is configured", async () => {
    const { octokit } = fakeOctokit([]);
    const connector = createGithubConnector({ repos: ["o/r"] }, { octokitFactory: () => octokit });
    await expect(collect(connector.sync(ctx({ secret: async () => null })))).rejects.toThrow(
      /no token configured/,
    );
  });

  test("no repos configured yields nothing (and never builds a client)", async () => {
    let built = false;
    const connector = createGithubConnector(
      { repos: [] },
      {
        octokitFactory: () => {
          built = true;
          return fakeOctokit([]).octokit;
        },
      },
    );
    const records = await collect(connector.sync(ctx()));
    expect(records).toEqual([]);
    expect(built).toBe(false);
  });
});
