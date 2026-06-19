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
          for (const page of pages) yield page;
        })();
      },
    },
  };
  return { octokit, calls };
}

/**
 * Build a route-aware fake Octokit: the issues route yields `issuePages`, the
 * notifications route yields `notificationPages`. Used to exercise both delta
 * axes independently (Issue #93).
 */
function fakeRoutedOctokit(opts: {
  issuePages?: Array<{ data: unknown[] }>;
  notificationPages?: Array<{ data: unknown[] }>;
}): {
  octokit: OctokitLike;
  calls: Array<{ route: string; params: Record<string, unknown> }>;
} {
  const calls: Array<{ route: string; params: Record<string, unknown> }> = [];
  const octokit: OctokitLike = {
    paginate: {
      iterator(route, params) {
        calls.push({ route, params });
        const pages =
          route === "GET /notifications" ? (opts.notificationPages ?? []) : (opts.issuePages ?? []);
        return (async function* () {
          for (const page of pages) yield page;
        })();
      },
    },
  };
  return { octokit, calls };
}

const notification = {
  id: "n1",
  reason: "mention",
  updated_at: "2026-06-15T00:00:00Z",
  unread: true,
  subject: { title: "You were mentioned", type: "Issue", url: "https://api.github.com/..." },
  repository: { full_name: "o/r" },
};
const otherRepoNotification = {
  id: "n2",
  reason: "review_requested",
  updated_at: "2026-06-16T00:00:00Z",
  unread: true,
  subject: { title: "Review requested", type: "PullRequest", url: null },
  repository: { full_name: "o/other" },
};

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
  test("defaults: empty repos, state all, notifications off", () => {
    const c = GithubConnectorConfig.parse({});
    expect(c.repos).toEqual([]);
    expect(c.state).toBe("all");
    expect(c.notifications).toBe("off");
  });
  test("rejects an unknown notifications mode", () => {
    expect(() => GithubConnectorConfig.parse({ notifications: "some" })).toThrow();
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
  test("reads a legacy bare-string cursor as the issues `since` floor", async () => {
    const { octokit, calls } = fakeOctokit([{ data: [issue, pr] }]);
    const connector = createGithubConnector({ repos: ["o/r"] }, { octokitFactory: () => octokit });
    // A pre-notifications cursor is a bare ISO string (the issues high-water mark).
    await collect(connector.sync(ctx({ cursor: "2026-06-01T00:00:00Z" })));
    expect(calls[0]?.params.since).toBe("2026-06-01T00:00:00Z");

    const result = await connector.finalize?.();
    // Cursor is now a JSON map; pr.updated_at (2026-06-12) is the most recent.
    expect(JSON.parse(result?.cursor ?? "{}")).toEqual({
      issues: "2026-06-12T00:00:00Z",
      notifications: null,
    });
  });

  test("first run omits `since`", async () => {
    const { octokit, calls } = fakeOctokit([{ data: [issue] }]);
    const connector = createGithubConnector({ repos: ["o/r"] }, { octokitFactory: () => octokit });
    await collect(connector.sync(ctx()));
    expect(calls[0]?.params.since).toBeUndefined();
  });

  test("first run with no items persists a null cursor", async () => {
    const { octokit } = fakeOctokit([{ data: [] }]);
    const connector = createGithubConnector({ repos: ["o/r"] }, { octokitFactory: () => octokit });
    await collect(connector.sync(ctx()));
    expect((await connector.finalize?.())?.cursor).toBeNull();
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

  test("no repos and notifications off yields nothing (and never builds a client)", async () => {
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

  test("no repos but notifications on still ingests the stream", async () => {
    const { octokit, calls } = fakeRoutedOctokit({ notificationPages: [{ data: [notification] }] });
    const connector = createGithubConnector(
      { repos: [], notifications: "all" },
      { octokitFactory: () => octokit },
    );
    const records = await collect(connector.sync(ctx()));
    expect(records).toHaveLength(1);
    expect(records[0]?.sourceType).toBe("github_notification");
    // No issues route is called when there are no repos.
    expect(calls.map((c) => c.route)).toEqual(["GET /notifications"]);
  });
});

describe("GitHub connector — notifications (Issue #93)", () => {
  test("maps a notification thread to a token-scoped source record", async () => {
    const { octokit } = fakeRoutedOctokit({ notificationPages: [{ data: [notification] }] });
    const connector = createGithubConnector(
      { repos: ["o/r"], notifications: "all" },
      { octokitFactory: () => octokit },
    );
    const records = await collect(connector.sync(ctx()));
    const rec = records.find((r) => r.sourceType === "github_notification");
    // Token-scoped identity: not repo-prefixed.
    expect(rec?.externalId).toBe("gh:notification:n1");
    expect(rec?.body).toBe("You were mentioned");
    expect(rec?.observedAt).toBe("2026-06-15T00:00:00Z");
    expect(rec?.meta).toMatchObject({
      repo: "o/r",
      reason: "mention",
      subjectType: "Issue",
      unread: true,
    });
  });

  test("off (default) never calls the notifications route", async () => {
    const { octokit, calls } = fakeRoutedOctokit({
      issuePages: [{ data: [issue] }],
      notificationPages: [{ data: [notification] }],
    });
    const connector = createGithubConnector({ repos: ["o/r"] }, { octokitFactory: () => octokit });
    const records = await collect(connector.sync(ctx()));
    expect(records.every((r) => r.sourceType !== "github_notification")).toBe(true);
    expect(calls.some((c) => c.route === "GET /notifications")).toBe(false);
  });

  test("mode=repos filters the stream to the configured allowlist", async () => {
    const { octokit } = fakeRoutedOctokit({
      notificationPages: [{ data: [notification, otherRepoNotification] }],
    });
    const connector = createGithubConnector(
      { repos: ["o/r"], notifications: "repos" },
      { octokitFactory: () => octokit },
    );
    const records = await collect(connector.sync(ctx()));
    const notifs = records.filter((r) => r.sourceType === "github_notification");
    // Only the allowlisted repo's notification is yielded.
    expect(notifs).toHaveLength(1);
    expect(notifs[0]?.externalId).toBe("gh:notification:n1");
  });

  test("notifications carry their own `since` cursor, decoupled from issues", async () => {
    const { octokit, calls } = fakeRoutedOctokit({
      issuePages: [{ data: [issue, pr] }],
      notificationPages: [{ data: [notification, otherRepoNotification] }],
    });
    const connector = createGithubConnector(
      { repos: ["o/r"], notifications: "all" },
      { octokitFactory: () => octokit },
    );
    // Resume from a JSON cursor with distinct floors per axis.
    const cursor = JSON.stringify({
      issues: "2026-06-01T00:00:00Z",
      notifications: "2026-06-14T00:00:00Z",
    });
    await collect(connector.sync(ctx({ cursor })));

    const issuesCall = calls.find((c) => c.route !== "GET /notifications");
    const notifCall = calls.find((c) => c.route === "GET /notifications");
    expect(issuesCall?.params.since).toBe("2026-06-01T00:00:00Z");
    expect(notifCall?.params.since).toBe("2026-06-14T00:00:00Z");

    const result = await connector.finalize?.();
    // Each axis advances independently: issues→pr (06-12), notifications→n2 (06-16).
    expect(JSON.parse(result?.cursor ?? "{}")).toEqual({
      issues: "2026-06-12T00:00:00Z",
      notifications: "2026-06-16T00:00:00Z",
    });
  });

  test("mode=repos still advances the cursor over filtered-out threads", async () => {
    const { octokit } = fakeRoutedOctokit({
      // Only the other-repo notification (06-16) is present; it is filtered out
      // of output but must still advance the notifications high-water mark so it
      // never re-floods next run.
      notificationPages: [{ data: [otherRepoNotification] }],
    });
    const connector = createGithubConnector(
      { repos: ["o/r"], notifications: "repos" },
      { octokitFactory: () => octokit },
    );
    const records = await collect(connector.sync(ctx()));
    expect(records.filter((r) => r.sourceType === "github_notification")).toHaveLength(0);
    const result = await connector.finalize?.();
    expect(JSON.parse(result?.cursor ?? "{}").notifications).toBe("2026-06-16T00:00:00Z");
  });
});
