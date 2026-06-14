/**
 * Connector e2e: sync → projection → FTS search hit (Issue #10 test plan).
 *
 * Drives the GitHub connector through the shared sync service with a mock
 * Octokit, then asserts the ingested body is searchable via the same FTS-first
 * retrieval service the `search` CLI / MCP tool use — exercising the full
 * ingest → event → projection → search vertical slice.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createGithubConnector, type OctokitLike } from "../../src/connectors/github.ts";
import { syncConnector } from "../../src/connectors/index.ts";
import { runConnectorSyncTool } from "../../src/connectors/mcp-tool.ts";
import { Store } from "../../src/db/index.ts";
import { searchSources } from "../../src/retrieval/index.ts";

let store: Store;

beforeEach(() => {
  store = Store.open({ path: ":memory:" });
});

afterEach(() => {
  store.close();
});

function octokitWith(data: unknown[]): OctokitLike {
  return {
    paginate: {
      iterator(_route, _params) {
        return (async function* () {
          yield { data } as { data: never[] };
        })();
      },
    },
  };
}

const ISSUE = {
  number: 42,
  title: "Launch the rocket",
  body: "we need to deploy the rocket to orbit",
  state: "open",
  html_url: "https://github.com/o/r/issues/42",
  updated_at: "2026-06-10T00:00:00Z",
  user: { login: "alice" },
};

describe("sync → projection → search", () => {
  test("ingested GitHub issue is searchable via FTS", async () => {
    const connector = createGithubConnector(
      { repos: ["o/r"] },
      { octokitFactory: () => octokitWith([ISSUE]) },
    );
    const out = await syncConnector(store, connector, {
      secrets: { env: { SUASOR_CONNECTOR_GITHUB_TOKEN: "tok" } },
    });
    expect(out.observed).toBe(1);

    const result = searchSources(store.connection.sqlite, "rocket");
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.externalId).toBe("gh:o/r:issue:42");
    expect(result.hits[0]?.sourceType).toBe("github_issue");
  });

  test("survives a projections rebuild (event log is the source of truth)", async () => {
    const connector = createGithubConnector(
      { repos: ["o/r"] },
      { octokitFactory: () => octokitWith([ISSUE]) },
    );
    await syncConnector(store, connector, {
      secrets: { env: { SUASOR_CONNECTOR_GITHUB_TOKEN: "tok" } },
    });
    store.rebuild();
    const result = searchSources(store.connection.sqlite, "orbit");
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.externalId).toBe("gh:o/r:issue:42");
  });
});

describe("connector.sync MCP tool shares the CLI service path (D5)", () => {
  test("runConnectorSyncTool ingests and returns counts", async () => {
    // Register a one-off connector via the registry by stubbing octokit globally
    // is overkill; instead exercise the tool with the real registry + injected
    // env secret, asserting it reaches the same outcome shape as the service.
    const out = await runConnectorSyncTool(
      { connector: "github" },
      {
        store,
        config: { connectors: { github: { repos: [] } } },
        secrets: { env: { SUASOR_CONNECTOR_GITHUB_TOKEN: "tok" } },
      },
    );
    // repos:[] → no records, but a completed sync with 0 counts (write tool ran).
    expect(out).toMatchObject({ connector: "github", observed: 0, updated: 0, unchanged: 0 });
  });

  test("unknown connector is rejected", async () => {
    await expect(
      runConnectorSyncTool({ connector: "nope" }, { store, config: { connectors: {} } }),
    ).rejects.toThrow(/unknown connector/);
  });
});
