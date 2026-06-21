import { describe, expect, test } from "bun:test";
import type { SourceRecord, SyncContext } from "../../src/connectors/contract.ts";
import { syncConnector } from "../../src/connectors/index.ts";
import {
  flattenRichText,
  type JiraAuth,
  type JiraClientLike,
  type JiraComment,
  type JiraIssue,
  type JiraTransport,
  makeDefaultTransport,
  makeJiraClient,
  projectKeyOf,
  shouldStopPaging,
} from "../../src/connectors/jira/client.ts";
import {
  buildExplicitJql,
  buildProjectJql,
  commentToRecord,
  createJiraConnector,
  issueToRecord,
  JiraConnectorConfig,
  jqlTimestamp,
  quoteJql,
} from "../../src/connectors/jira.ts";
import { Store } from "../../src/db/index.ts";

const HOST = "example.atlassian.net";

function ctx(overrides: Partial<SyncContext> = {}): SyncContext {
  return {
    cursor: null,
    secret: async (name) => (name === "token" ? "secret-tok" : null),
    ...overrides,
  };
}

async function collect(it: AsyncIterable<SourceRecord>): Promise<SourceRecord[]> {
  const out: SourceRecord[] = [];
  for await (const r of it) out.push(r);
  return out;
}

/** A fake structural client streaming pre-canned issues + comments per project. */
function fakeClient(opts: {
  issues?: JiraIssue[];
  comments?: Record<string, JiraComment[]>;
  fail?: { search?: Record<string, Error>; comments?: Record<string, Error> };
  jqlSeen?: string[];
}): JiraClientLike {
  return {
    async *searchIssues(jql) {
      opts.jqlSeen?.push(jql);
      // Fail keyed by the project clause (`project = "KEY"`).
      for (const [key, err] of Object.entries(opts.fail?.search ?? {})) {
        if (jql.includes(`project = "${key}"`)) throw err;
      }
      for (const issue of opts.issues ?? []) {
        if (jql.includes(`project = "${issue.projectKey}"`) || jql.startsWith("custom")) {
          yield issue;
        }
      }
    },
    async *issueComments(issueKey, projectKey) {
      const err = opts.fail?.comments?.[issueKey];
      if (err) throw err;
      for (const c of opts.comments?.[issueKey] ?? []) {
        void projectKey;
        yield c;
      }
    },
  };
}

const issue = (over: Partial<JiraIssue> = {}): JiraIssue => ({
  key: "PROJ-1",
  projectKey: "PROJ",
  summary: "Summary",
  description: "Description",
  updated: "2026-06-10T00:00:00.000Z",
  ...over,
});

describe("JiraConnectorConfig", () => {
  test("defaults: empty projects, auth=basic", () => {
    const parsed = JiraConnectorConfig.parse({});
    expect(parsed.projects).toEqual([]);
    expect(parsed.auth).toBe("basic");
    expect(parsed.host).toBe("");
  });

  test("passthrough keeps unknown keys (forward-compat)", () => {
    const parsed = JiraConnectorConfig.parse({ extra: "x" }) as Record<string, unknown>;
    expect(parsed.extra).toBe("x");
  });

  test("rejects an unknown auth scheme", () => {
    expect(() => JiraConnectorConfig.parse({ auth: "oauth" })).toThrow();
  });

  test("accepts a bare host and host:port", () => {
    expect(JiraConnectorConfig.parse({ host: "example.atlassian.net" }).host).toBe(
      "example.atlassian.net",
    );
    expect(JiraConnectorConfig.parse({ host: "jira.internal:8443" }).host).toBe(
      "jira.internal:8443",
    );
  });

  test("rejects a host carrying a scheme / path / userinfo (credential-misdirection guard)", () => {
    expect(() => JiraConnectorConfig.parse({ host: "https://example.atlassian.net" })).toThrow();
    expect(() => JiraConnectorConfig.parse({ host: "evil.com/x" })).toThrow();
    expect(() => JiraConnectorConfig.parse({ host: "user@evil.com" })).toThrow();
    expect(() => JiraConnectorConfig.parse({ host: "evil.com?" })).toThrow();
  });
});

describe("identity + source_type + fingerprint (ADR-0007)", () => {
  test("issue maps to jira_issue with host+project-scoped id", () => {
    const rec = issueToRecord(HOST, issue());
    expect(rec.externalId).toBe("jira:example.atlassian.net:PROJ:PROJ-1");
    expect(rec.sourceType).toBe("jira_issue");
    expect(rec.body).toBe("Summary\n\nDescription");
    expect(rec.fingerprint).toBe("2026-06-10T00:00:00.000Z");
    expect(rec.observedAt).toBe("2026-06-10T00:00:00.000Z");
  });

  test("comment maps to jira_comment scoped under its issue", () => {
    const rec = commentToRecord(HOST, {
      id: "10",
      issueKey: "PROJ-1",
      projectKey: "PROJ",
      body: "a comment",
      updated: "2026-06-11T00:00:00.000Z",
      author: "Alice",
    });
    expect(rec.externalId).toBe("jira:example.atlassian.net:PROJ:PROJ-1:comment:10");
    expect(rec.sourceType).toBe("jira_comment");
    expect(rec.body).toBe("a comment");
    expect(rec.meta.author).toBe("Alice");
  });

  test("the same issue key under two hosts yields distinct identities", () => {
    const a = issueToRecord("a.atlassian.net", issue());
    const b = issueToRecord("b.atlassian.net", issue());
    expect(a.externalId).not.toBe(b.externalId);
  });

  test("body falls back to summary alone when description is missing", () => {
    const rec = issueToRecord(HOST, issue({ description: "" }));
    expect(rec.body).toBe("Summary");
  });
});

describe("JQL building (per-project delta)", () => {
  test("project JQL with no floor reads everything, ordered ASC", () => {
    expect(buildProjectJql("PROJ", undefined)).toBe('project = "PROJ" ORDER BY updated ASC');
  });

  test("project JQL with a floor appends updated >= with minute precision", () => {
    expect(buildProjectJql("PROJ", "2026-06-10T12:34:56.000Z")).toBe(
      'project = "PROJ" AND updated >= "2026-06-10 12:34" ORDER BY updated ASC',
    );
  });

  test("explicit JQL wraps the operator query and appends the floor", () => {
    expect(buildExplicitJql("assignee = currentUser()", "2026-06-10T00:00:00.000Z")).toBe(
      '(assignee = currentUser()) AND updated >= "2026-06-10 00:00" ORDER BY updated ASC',
    );
  });

  test("explicit JQL keeps an operator-supplied ORDER BY (no double order)", () => {
    expect(buildExplicitJql("status = Done ORDER BY created", undefined)).toBe(
      "status = Done ORDER BY created",
    );
  });

  test("jqlTimestamp passes through a non-ISO value unchanged", () => {
    expect(jqlTimestamp("2026-06-10")).toBe("2026-06-10");
  });

  test("projectKeyOf splits the trailing number off an issue key", () => {
    expect(projectKeyOf("PROJ-123")).toBe("PROJ");
    expect(projectKeyOf("nodash")).toBe("");
  });

  test("quoteJql escapes embedded quotes and backslashes (injection guard)", () => {
    expect(quoteJql("PROJ")).toBe('"PROJ"');
    expect(quoteJql('A" OR project=B OR "')).toBe('"A\\" OR project=B OR \\""');
    expect(quoteJql("back\\slash")).toBe('"back\\\\slash"');
  });

  test("buildProjectJql escapes a key with a quote so it cannot break out", () => {
    const jql = buildProjectJql('A" OR x', undefined);
    expect(jql).toBe('project = "A\\" OR x" ORDER BY updated ASC');
  });
});

describe("shouldStopPaging (reliable-total vs page-shape)", () => {
  test("stops on an empty page regardless of total", () => {
    expect(shouldStopPaging(100, 0, 50, 100)).toBe(true);
  });

  test("with a reliable total, stops once startAt reaches it", () => {
    expect(shouldStopPaging(2, 1, 1, 100)).toBe(false); // startAt 1 < total 2
    expect(shouldStopPaging(2, 1, 2, 100)).toBe(true); // startAt 2 >= total 2
  });

  test("with a negative/absent total, falls back to short-page detection", () => {
    // Jira approximate-count mode (total: -1): a full page may have more.
    expect(shouldStopPaging(-1, 100, 100, 100)).toBe(false);
    // A short page is the last page.
    expect(shouldStopPaging(-1, 30, 30, 100)).toBe(true);
    expect(shouldStopPaging(undefined, 100, 100, 100)).toBe(false);
    expect(shouldStopPaging(undefined, 30, 30, 100)).toBe(true);
  });
});

describe("ADF / HTML → text flattening (custom-field-absent resilient)", () => {
  test("flattens an ADF document into newline-joined paragraphs", () => {
    const adf = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "first line" }] },
        { type: "paragraph", content: [{ type: "text", text: "second line" }] },
      ],
    };
    expect(flattenRichText(adf)).toBe("first line\nsecond line");
  });

  test("strips HTML tags from an HTML description", () => {
    expect(flattenRichText("<p>hello</p><p>world</p>")).toBe("hello\nworld");
  });

  test("a missing / null description yields an empty string (no throw)", () => {
    expect(flattenRichText(null)).toBe("");
    expect(flattenRichText(undefined)).toBe("");
    expect(flattenRichText(42)).toBe("");
  });

  test("a plain string description passes through trimmed", () => {
    expect(flattenRichText("  just text  ")).toBe("just text");
  });
});

describe("Jira connector — project sweep (issues + comments interleaved)", () => {
  test("streams issues and their comments per project", async () => {
    const client = fakeClient({
      issues: [issue({ key: "PROJ-1" }), issue({ key: "PROJ-2" })],
      comments: {
        "PROJ-1": [
          {
            id: "100",
            issueKey: "PROJ-1",
            projectKey: "PROJ",
            body: "c1",
            updated: "2026-06-10T01:00:00.000Z",
            author: "Bob",
          },
        ],
      },
    });
    const connector = createJiraConnector(
      { host: HOST, email: "me@example.com", projects: ["PROJ"] },
      { clientFactory: () => client },
    );
    const records = await collect(connector.sync(ctx()));
    expect(records.map((r) => r.externalId)).toEqual([
      "jira:example.atlassian.net:PROJ:PROJ-1",
      "jira:example.atlassian.net:PROJ:PROJ-1:comment:100",
      "jira:example.atlassian.net:PROJ:PROJ-2",
    ]);
  });

  test("no projects yields nothing (never builds a client)", async () => {
    let built = false;
    const connector = createJiraConnector(
      { host: HOST, email: "me@example.com", projects: [] },
      {
        clientFactory: () => {
          built = true;
          return fakeClient({});
        },
      },
    );
    expect(await collect(connector.sync(ctx()))).toEqual([]);
    expect(built).toBe(false);
  });
});

describe("Jira connector — per-project cursor (delta)", () => {
  test("finalize records the highest updated per project as a JSON cursor", async () => {
    const client = fakeClient({
      issues: [
        issue({ key: "PROJ-1", updated: "2026-06-10T00:00:00.000Z" }),
        issue({ key: "PROJ-2", updated: "2026-06-12T00:00:00.000Z" }),
      ],
    });
    const connector = createJiraConnector(
      { host: HOST, email: "me@example.com", projects: ["PROJ"] },
      { clientFactory: () => client },
    );
    await collect(connector.sync(ctx()));
    const result = await connector.finalize?.();
    expect(JSON.parse(result?.cursor ?? "{}")).toEqual({ PROJ: "2026-06-12T00:00:00.000Z" });
  });

  test("a saved cursor seeds the per-project updated >= floor in the JQL", async () => {
    const jqlSeen: string[] = [];
    const client = fakeClient({ issues: [], jqlSeen });
    const connector = createJiraConnector(
      { host: HOST, email: "me@example.com", projects: ["PROJ"] },
      { clientFactory: () => client },
    );
    await collect(
      connector.sync(ctx({ cursor: JSON.stringify({ PROJ: "2026-06-10T12:00:00.000Z" }) })),
    );
    expect(jqlSeen[0]).toContain('updated >= "2026-06-10 12:00"');
  });

  test("a project with no new issues preserves its prior cursor floor", async () => {
    const client = fakeClient({ issues: [] });
    const connector = createJiraConnector(
      { host: HOST, email: "me@example.com", projects: ["PROJ"] },
      { clientFactory: () => client },
    );
    await collect(
      connector.sync(ctx({ cursor: JSON.stringify({ PROJ: "2026-06-01T00:00:00.000Z" }) })),
    );
    const result = await connector.finalize?.();
    expect(JSON.parse(result?.cursor ?? "{}")).toEqual({ PROJ: "2026-06-01T00:00:00.000Z" });
  });

  test("explicit jql mode sweeps once under the __jql__ cursor key", async () => {
    const jqlSeen: string[] = [];
    const client = fakeClient({
      issues: [issue({ key: "PROJ-9", updated: "2026-06-15T00:00:00.000Z" })],
      jqlSeen,
    });
    const connector = createJiraConnector(
      { host: HOST, email: "me@example.com", jql: "custom = filter" },
      { clientFactory: () => client },
    );
    await collect(connector.sync(ctx()));
    expect(jqlSeen).toHaveLength(1);
    const result = await connector.finalize?.();
    expect(JSON.parse(result?.cursor ?? "{}")).toEqual({
      __jql__: "2026-06-15T00:00:00.000Z",
    });
  });
});

describe("Jira connector — guards + auth resolution", () => {
  test("throws when no token is configured", async () => {
    const connector = createJiraConnector(
      { host: HOST, email: "me@example.com", projects: ["PROJ"] },
      { clientFactory: () => fakeClient({}) },
    );
    await expect(collect(connector.sync(ctx({ secret: async () => null })))).rejects.toThrow(
      /no token configured/,
    );
  });

  test("basic auth without an email throws before any fetch", async () => {
    let built = false;
    const connector = createJiraConnector(
      { host: HOST, projects: ["PROJ"] },
      {
        clientFactory: () => {
          built = true;
          return fakeClient({});
        },
      },
    );
    await expect(collect(connector.sync(ctx()))).rejects.toThrow(/email is required/);
    expect(built).toBe(false);
  });

  test("bearer auth needs no email (self-hosted PAT)", async () => {
    const client = fakeClient({ issues: [issue()] });
    const connector = createJiraConnector(
      { host: "jira.internal", auth: "bearer", projects: ["PROJ"] },
      { clientFactory: () => client },
    );
    const records = await collect(connector.sync(ctx()));
    expect(records).toHaveLength(1);
  });
});

describe("Jira connector — per-project error isolation (Issue #193)", () => {
  test("one project failing is skipped; the rest stream; one aggregated warn", async () => {
    const client = fakeClient({
      issues: [issue({ key: "OK-1", projectKey: "OK" })],
      fail: { search: { BAD: new Error("404 Not Found") } },
    });
    const warns: string[] = [];
    const connector = createJiraConnector(
      { host: HOST, email: "me@example.com", projects: ["OK", "BAD"] },
      { clientFactory: () => client },
    );
    const records = await collect(connector.sync(ctx({ onWarn: (m) => warns.push(m) })));
    expect(records.map((r) => r.externalId)).toEqual(["jira:example.atlassian.net:OK:OK-1"]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("BAD (404 Not Found)");
  });

  test("partial failure sets partialFailure + a summary line in finalize", async () => {
    const client = fakeClient({
      issues: [issue({ key: "OK-1", projectKey: "OK" })],
      fail: { search: { BAD: new Error("boom") } },
    });
    const connector = createJiraConnector(
      { host: HOST, email: "me@example.com", projects: ["OK", "BAD"] },
      { clientFactory: () => client },
    );
    await collect(connector.sync(ctx({ onWarn: () => {} })));
    const result = await connector.finalize?.();
    expect(result?.partialFailure).toBe(true);
    expect(result?.summaryLines?.[0]).toContain("BAD=failed (cursor preserved)");
  });

  test("a failed project preserves its prior cursor (not a reset)", async () => {
    const client = fakeClient({
      issues: [issue({ key: "OK-1", projectKey: "OK", updated: "2026-06-20T00:00:00.000Z" })],
      fail: { search: { BAD: new Error("boom") } },
    });
    const connector = createJiraConnector(
      { host: HOST, email: "me@example.com", projects: ["OK", "BAD"] },
      { clientFactory: () => client },
    );
    await collect(
      connector.sync(
        ctx({ cursor: JSON.stringify({ BAD: "2026-06-01T00:00:00.000Z" }), onWarn: () => {} }),
      ),
    );
    const result = await connector.finalize?.();
    expect(JSON.parse(result?.cursor ?? "{}").BAD).toBe("2026-06-01T00:00:00.000Z");
  });

  test("all projects failing throws", async () => {
    const client = fakeClient({
      fail: { search: { A: new Error("401"), B: new Error("403") } },
    });
    const connector = createJiraConnector(
      { host: HOST, email: "me@example.com", projects: ["A", "B"] },
      { clientFactory: () => client },
    );
    await expect(collect(connector.sync(ctx({ onWarn: () => {} })))).rejects.toThrow(/40[13]/);
  });
});

/** A transport that replays canned responses keyed by the request path prefix. */
function cannedTransport(
  routes: { search?: { status: number; body: unknown }[] } & {
    comments?: Record<string, { status: number; body: unknown }>;
  },
): { transport: JiraTransport; calls: string[] } {
  const calls: string[] = [];
  let searchIdx = 0;
  const transport: JiraTransport = async ({ path }) => {
    calls.push(path);
    if (path.includes("/search")) {
      const list = routes.search ?? [];
      const res = list[searchIdx] ?? { status: 200, body: { issues: [], total: 0 } };
      searchIdx += 1;
      return res;
    }
    const issueKey = decodeURIComponent(path.split("/issue/")[1]?.split("/")[0] ?? "");
    return routes.comments?.[issueKey] ?? { status: 200, body: { comments: [], total: 0 } };
  };
  return { transport, calls };
}

const AUTH: JiraAuth = {
  host: HOST,
  authorization: "Basic xxx",
  apiBase: "/rest/api/3",
};

describe("Jira client — pagination, comments, error mapping", () => {
  test("paginates search via startAt until total is reached", async () => {
    const { transport, calls } = cannedTransport({
      search: [
        {
          status: 200,
          body: {
            total: 2,
            issues: [{ key: "PROJ-1", fields: { summary: "one", updated: "t1" } }],
          },
        },
        {
          status: 200,
          body: {
            total: 2,
            issues: [{ key: "PROJ-2", fields: { summary: "two", updated: "t2" } }],
          },
        },
      ],
    });
    const client = makeJiraClient(AUTH, transport);
    const issues: JiraIssue[] = [];
    for await (const i of client.searchIssues('project = "PROJ"')) issues.push(i);
    expect(issues.map((i) => i.key)).toEqual(["PROJ-1", "PROJ-2"]);
    expect(calls.filter((c) => c.includes("startAt=1")).length).toBe(1);
  });

  test("paginates past page 1 when total is -1 (approximate-count mode)", async () => {
    // A full first page (PAGE_SIZE=100) with total:-1 must NOT truncate; a short
    // second page ends the sweep.
    const full = Array.from({ length: 100 }, (_, i) => ({
      key: `PROJ-${i + 1}`,
      fields: { summary: "s", updated: "t" },
    }));
    const { transport } = cannedTransport({
      search: [
        { status: 200, body: { total: -1, issues: full } },
        {
          status: 200,
          body: {
            total: -1,
            issues: [{ key: "PROJ-101", fields: { summary: "s", updated: "t" } }],
          },
        },
      ],
    });
    const client = makeJiraClient(AUTH, transport);
    const issues: JiraIssue[] = [];
    for await (const i of client.searchIssues('project = "PROJ"')) issues.push(i);
    expect(issues).toHaveLength(101);
    expect(issues.at(-1)?.key).toBe("PROJ-101");
  });

  test("derives the project key from the issue key when fields.project is absent", async () => {
    const { transport } = cannedTransport({
      search: [
        {
          status: 200,
          body: { total: 1, issues: [{ key: "ABC-7", fields: { summary: "s", updated: "t" } }] },
        },
      ],
    });
    const client = makeJiraClient(AUTH, transport);
    const issues: JiraIssue[] = [];
    for await (const i of client.searchIssues('project = "ABC"')) issues.push(i);
    expect(issues[0]?.projectKey).toBe("ABC");
  });

  test("fetches issue comments paginated via startAt", async () => {
    const { transport } = cannedTransport({
      comments: {
        "PROJ-1": {
          status: 200,
          body: {
            total: 1,
            comments: [{ id: "5", body: "hi", updated: "t", author: { displayName: "Z" } }],
          },
        },
      },
    });
    const client = makeJiraClient(AUTH, transport);
    const comments: JiraComment[] = [];
    for await (const c of client.issueComments("PROJ-1", "PROJ")) comments.push(c);
    expect(comments[0]?.id).toBe("5");
    expect(comments[0]?.author).toBe("Z");
  });

  test("non-2xx throws with the Jira errorMessages, never the credential", async () => {
    const { transport } = cannedTransport({
      search: [{ status: 401, body: { errorMessages: ["Client must be authenticated."] } }],
    });
    const client = makeJiraClient(
      { host: HOST, authorization: "Basic super-secret", apiBase: "/rest/api/3" },
      transport,
    );
    const run = (async () => {
      for await (const _ of client.searchIssues('project = "X"')) {
        // drain
      }
    })();
    await expect(run).rejects.toThrow(
      /jira GET .*\/search failed: 401 Client must be authenticated/,
    );
    await run.catch((e: Error) => expect(e.message).not.toContain("super-secret"));
  });

  test("429 then success is retried via an injected retrying transport", async () => {
    let searchCalls = 0;
    const base: JiraTransport = async ({ path }) => {
      if (path.includes("/search")) {
        searchCalls += 1;
        if (searchCalls === 1) throw new Error("transient");
        return {
          status: 200,
          body: { total: 1, issues: [{ key: "P-1", fields: { summary: "s", updated: "t" } }] },
        };
      }
      return { status: 200, body: { comments: [], total: 0 } };
    };
    const retrying: JiraTransport = async (req) => {
      try {
        return await base(req);
      } catch {
        return await base(req);
      }
    };
    const client = makeJiraClient(AUTH, retrying);
    const issues: JiraIssue[] = [];
    for await (const i of client.searchIssues('project = "P"')) issues.push(i);
    expect(issues.map((i) => i.key)).toEqual(["P-1"]);
    expect(searchCalls).toBe(2);
  });
});

describe("Jira client — default fetch transport (injected fetchImpl)", () => {
  test("sends the Authorization header and parses a JSON body", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const transport = makeDefaultTransport({
      fetchImpl: async (url, init) => {
        seenUrl = url;
        seenAuth = (init?.headers as Record<string, string>).Authorization ?? "";
        return new Response(JSON.stringify({ total: 0, issues: [] }), { status: 200 });
      },
    });
    const { status, body } = await transport({ auth: AUTH, path: "/rest/api/3/search?jql=x" });
    expect(status).toBe(200);
    expect(seenUrl).toBe("https://example.atlassian.net/rest/api/3/search?jql=x");
    expect(seenAuth).toBe("Basic xxx");
    expect((body as { total: number }).total).toBe(0);
  });

  test("a non-JSON body degrades to an empty object (status drives the verdict)", async () => {
    const transport = makeDefaultTransport({
      fetchImpl: async () => new Response("<html>502</html>", { status: 502 }),
    });
    const { status, body } = await transport({ auth: AUTH, path: "/rest/api/3/search" });
    expect(status).toBe(502);
    expect(body).toEqual({});
  });

  test("a 429 with Retry-After is retried then succeeds (no real wait)", async () => {
    let calls = 0;
    const transport = makeDefaultTransport({
      sleep: async () => {},
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          return new Response("{}", { status: 429, headers: { "retry-after": "1" } });
        }
        return new Response(JSON.stringify({ total: 0, issues: [] }), { status: 200 });
      },
    });
    const { status } = await transport({ auth: AUTH, path: "/rest/api/3/search" });
    expect(status).toBe(200);
    expect(calls).toBe(2);
  });
});

describe("Jira connector — end-to-end through the sync service", () => {
  test("persists an issue body and detects no-op vs updated change", async () => {
    const store = Store.open({ path: ":memory:" });
    try {
      const make = (it: JiraIssue) =>
        createJiraConnector(
          { host: HOST, email: "me@example.com", projects: ["PROJ"] },
          { clientFactory: () => fakeClient({ issues: [it] }) },
        );

      const first = await syncConnector(store, make(issue()), {
        secrets: { env: { SUASOR_CONNECTOR_JIRA_TOKEN: "tok" } },
      });
      expect(first.observed).toBe(1);
      const body = store.connection.sqlite
        .query<{ body: string }, [string]>("SELECT body FROM sources WHERE external_id = ?")
        .get("jira:example.atlassian.net:PROJ:PROJ-1")?.body;
      expect(body).toBe("Summary\n\nDescription");

      // Same updated fingerprint → no update on a second run.
      const second = await syncConnector(store, make(issue()), {
        secrets: { env: { SUASOR_CONNECTOR_JIRA_TOKEN: "tok" } },
      });
      expect(second.updated).toBe(0);

      // updated advances → re-ingest even if body is unchanged.
      const third = await syncConnector(
        store,
        make(issue({ updated: "2026-07-01T00:00:00.000Z" })),
        { secrets: { env: { SUASOR_CONNECTOR_JIRA_TOKEN: "tok" } } },
      );
      expect(third.updated).toBe(1);
    } finally {
      store.close();
    }
  });
});
