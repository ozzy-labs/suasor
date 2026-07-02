/**
 * Pre-sync no-op config detection (Issue #187).
 *
 * `noopWarning` returns a human-readable advisory when an *enabled* connector
 * slice resolves to "no ingest target" (empty scope), or `null` otherwise. This
 * is the shared logic both `suasor <connector> sync` and `suasor sync` use to warn
 * before a silent 0-observed run. Pure / SDK-free, so it is exercised directly.
 */
import { describe, expect, test } from "bun:test";
import { noopWarning } from "../../src/connectors/noop-check.ts";

describe("noopWarning — empty/no-op slices warn", () => {
  test("github: no repos + notifications off", () => {
    expect(noopWarning("github", { repos: [] })).toContain("取り込み対象なし");
    // Default slice (no fields) resolves to repos=[] + notifications=off.
    expect(noopWarning("github", {})).toContain("notifications=off");
  });

  test("box: no folders", () => {
    expect(noopWarning("box", { folders: [] })).toContain("取り込み対象なし");
    expect(noopWarning("box", {})).toContain("folders");
  });

  test("local: no roots", () => {
    expect(noopWarning("local", { roots: [] })).toContain("取り込み対象なし");
    expect(noopWarning("local", {})).toContain("roots");
  });

  test("web: no urls", () => {
    expect(noopWarning("web", { urls: [] })).toContain("取り込み対象なし");
    expect(noopWarning("web", {})).toContain("urls");
  });

  test("google: empty resources", () => {
    expect(noopWarning("google", { resources: [] })).toContain("取り込み対象なし");
    expect(noopWarning("google", { resources: [] })).toContain("resources");
  });

  test("ms-graph: empty resources", () => {
    expect(noopWarning("ms-graph", { resources: [] })).toContain("取り込み対象なし");
  });

  test("slack: flat workspace with no channels", () => {
    expect(noopWarning("slack", { channels: [] })).toContain("channels");
    expect(noopWarning("slack", {})).toContain("取り込み対象なし");
    // The advisory names the discovery verb so the operator can copy real ids
    // instead of hand-writing them (#385).
    expect(noopWarning("slack", {})).toContain("`suasor slack conversations`");
  });

  test("slack: multi-workspace where no workspace has channels", () => {
    const warn = noopWarning("slack", {
      workspaces: { acme: { team: "T1", channels: [] } },
    });
    expect(warn).toContain("workspaces");
    expect(warn).toContain("取り込み対象なし");
    expect(warn).toContain("`suasor slack conversations`");
  });

  test("notion: no databases + pages disabled", () => {
    expect(noopWarning("notion", { databases: [], pages: false })).toContain("取り込み対象なし");
    expect(noopWarning("notion", { databases: [], pages: false })).toContain("pages=false");
  });

  test("jira: no projects + no jql", () => {
    expect(noopWarning("jira", { projects: [] })).toContain("取り込み対象なし");
    // Default slice (no fields) resolves to projects=[] + jql unset.
    expect(noopWarning("jira", {})).toContain("projects");
  });
});

describe("noopWarning — configured slices do not warn", () => {
  test("github: repos configured", () => {
    expect(noopWarning("github", { repos: ["owner/repo"] })).toBeNull();
  });

  test("github: notifications stream enabled even with no repos", () => {
    expect(noopWarning("github", { repos: [], notifications: "all" })).toBeNull();
    expect(noopWarning("github", { notifications: "repos" })).toBeNull();
  });

  test("box / local / web with a target", () => {
    expect(noopWarning("box", { folders: ["0"] })).toBeNull();
    expect(noopWarning("local", { roots: ["/tmp"] })).toBeNull();
    expect(noopWarning("web", { urls: ["https://example.com"] })).toBeNull();
  });

  test("google / ms-graph with resources (default non-empty)", () => {
    expect(noopWarning("google", {})).toBeNull();
    expect(noopWarning("ms-graph", {})).toBeNull();
    expect(noopWarning("google", { resources: ["drive"] })).toBeNull();
  });

  test("slack: flat workspace with channels", () => {
    expect(noopWarning("slack", { channels: ["C123"] })).toBeNull();
  });

  test("slack: multi-workspace where one workspace has channels", () => {
    expect(
      noopWarning("slack", {
        workspaces: {
          acme: { team: "T1", channels: [] },
          beta: { team: "T2", channels: ["C9"] },
        },
      }),
    ).toBeNull();
  });

  test("notion: databases configured, or pages discovery on (default)", () => {
    expect(noopWarning("notion", { databases: ["db1"], pages: false })).toBeNull();
    // pages defaults to true, so a bare slice has a target (standalone pages).
    expect(noopWarning("notion", {})).toBeNull();
    expect(noopWarning("notion", { databases: [], pages: true })).toBeNull();
  });

  test("jira: projects configured, or an explicit jql", () => {
    expect(noopWarning("jira", { projects: ["PROJ"] })).toBeNull();
    expect(noopWarning("jira", { projects: [], jql: "assignee = currentUser()" })).toBeNull();
  });
});

describe("noopWarning — edge cases", () => {
  test("unknown connector → no warning", () => {
    expect(noopWarning("does-not-exist", {})).toBeNull();
  });

  test("malformed slice → no throw, no warning (loadConfig already gates #162)", () => {
    // A shape the schema would reject (repos must be string[]). The detector
    // swallows the parse error and returns null rather than turning a pre-sync
    // advisory into a hard error.
    expect(noopWarning("github", { repos: 42 } as never)).toBeNull();
  });
});
