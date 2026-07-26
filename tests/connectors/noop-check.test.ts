/**
 * Pre-sync no-op config detection (Issue #187).
 *
 * `noopWarning` returns a human-readable advisory when an *enabled* connector
 * slice resolves to "no ingest target" (empty scope), or `null` otherwise. This
 * is the shared logic both `suasor <connector> sync` and `suasor sync` use to warn
 * before a silent 0-observed run. Pure / SDK-free, so it is exercised directly.
 */
import { describe, expect, test } from "bun:test";
import type { ConnectorConfig } from "../../src/connectors/contract.ts";
import {
  accountSecretProbes,
  advisoryLabel,
  demotedDefaultAccountNotice,
  missingSettingWarnings,
  noopWarnings,
} from "../../src/connectors/noop-check.ts";

/**
 * Single-account adapters. The advisories are per account (ADR-0050), but a
 * config with no `accounts` table must keep producing exactly one unlabelled
 * message — so the pre-ADR-0050 assertions below are kept verbatim as the
 * regression guard for that path.
 */
function noopWarning(name: string, slice: ConnectorConfig): string | null {
  const advisories = noopWarnings(name, slice);
  expect(advisories.every((a) => a.account === null)).toBe(true);
  return advisories[0]?.message ?? null;
}

function missingSettingWarning(name: string, slice: ConnectorConfig): string | null {
  const advisories = missingSettingWarnings(name, slice);
  expect(advisories.every((a) => a.account === null)).toBe(true);
  return advisories[0]?.message ?? null;
}

describe("noopWarning — empty/no-op slices warn", () => {
  test("github: no repos + notifications off", () => {
    expect(noopWarning("github", { repos: [] })).toContain("nothing to ingest");
    // Default slice (no fields) resolves to repos=[] + notifications=off.
    expect(noopWarning("github", {})).toContain("notifications=off");
  });

  test("box: no folders", () => {
    expect(noopWarning("box", { folders: [] })).toContain("nothing to ingest");
    expect(noopWarning("box", {})).toContain("folders");
  });

  test("local: no roots", () => {
    expect(noopWarning("local", { roots: [] })).toContain("nothing to ingest");
    expect(noopWarning("local", {})).toContain("roots");
  });

  test("web: no urls", () => {
    expect(noopWarning("web", { urls: [] })).toContain("nothing to ingest");
    expect(noopWarning("web", {})).toContain("urls");
  });

  test("google: empty resources", () => {
    expect(noopWarning("google", { resources: [] })).toContain("nothing to ingest");
    expect(noopWarning("google", { resources: [] })).toContain("resources");
  });

  test("ms-graph: empty resources", () => {
    expect(noopWarning("ms-graph", { resources: [] })).toContain("nothing to ingest");
  });

  test("slack: flat workspace with no channels", () => {
    expect(noopWarning("slack", { channels: [] })).toContain("channels");
    expect(noopWarning("slack", {})).toContain("nothing to ingest");
    // The advisory names the discovery verb so the operator can copy real ids
    // instead of hand-writing them (#385).
    expect(noopWarning("slack", {})).toContain("`suasor slack conversations`");
  });

  test("slack: lists-only config has a target (no warn)", () => {
    // ADR-0042: the flat shape has a target when channels OR lists are set.
    expect(noopWarning("slack", { channels: [], lists: ["L1"] })).toBeNull();
  });

  test("notion: no databases + pages disabled", () => {
    expect(noopWarning("notion", { databases: [], pages: false })).toContain("nothing to ingest");
    expect(noopWarning("notion", { databases: [], pages: false })).toContain("pages=false");
  });

  test("jira: no projects + no jql", () => {
    expect(noopWarning("jira", { projects: [] })).toContain("nothing to ingest");
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

  test("slack: flat channels configured (ADR-0042)", () => {
    expect(noopWarning("slack", { channels: ["C9"] })).toBeNull();
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

describe("missingSettingWarning — required non-secret settings (ADR-0049)", () => {
  test("google: enabled with no clientId cannot reach its API", () => {
    const warning = missingSettingWarning("google", {});
    expect(warning).toContain("clientId");
    expect(warning).toContain("cannot reach its API");
  });

  test("ms-graph: both ids are named when both are missing", () => {
    const warning = missingSettingWarning("ms-graph", {});
    expect(warning).toContain("tenantId");
    expect(warning).toContain("clientId");
  });

  test("ms-graph: only the actually-missing key is named", () => {
    const warning = missingSettingWarning("ms-graph", { tenantId: "t-1" });
    expect(warning).toContain("clientId");
    expect(warning).not.toContain("tenantId (");
  });

  test("jira: host is required", () => {
    expect(missingSettingWarning("jira", {})).toContain("host");
  });

  test("a whitespace-only value counts as missing", () => {
    expect(missingSettingWarning("google", { clientId: "   " })).toContain("clientId");
  });

  test("a populated slice is quiet", () => {
    expect(
      missingSettingWarning("google", { clientId: "abc.apps.googleusercontent.com" }),
    ).toBeNull();
    expect(missingSettingWarning("ms-graph", { tenantId: "t", clientId: "c" })).toBeNull();
    expect(missingSettingWarning("jira", { host: "example.atlassian.net" })).toBeNull();
  });

  test("connectors that declare no required settings are always quiet", () => {
    expect(missingSettingWarning("github", {})).toBeNull();
    expect(missingSettingWarning("slack", {})).toBeNull();
    expect(missingSettingWarning("local", {})).toBeNull();
  });

  test("unknown connector → no warning", () => {
    expect(missingSettingWarning("does-not-exist", {})).toBeNull();
  });

  test("it is a separate verdict from the scope-emptiness one, not folded in", () => {
    // A google slice can be perfectly scoped and still unable to authenticate:
    // the two questions have different remedies, so both lines must be able to
    // fire independently.
    const slice = { resources: ["drive"] };
    expect(noopWarning("google", slice)).toBeNull();
    expect(missingSettingWarning("google", slice)).toContain("clientId");
  });
});

describe("per-account advisories (ADR-0050 / #441)", () => {
  test("one no-op advisory per account, attributed by name", () => {
    const advisories = noopWarnings("google", {
      resources: ["drive"],
      accounts: { personal: {}, work: { resources: [] } },
    });
    expect(advisories).toHaveLength(1);
    expect(advisories[0]?.account).toBe("work");
    expect(advisories[0]?.message).toContain("nothing to ingest");
  });

  test("a complete account does not vouch for an incomplete one", () => {
    // The connector-level verdict would be "fine" here: `personal` has a
    // clientId. That is exactly the state this per-account split exists to stop
    // hiding — `work` overrides it with an empty string.
    const advisories = missingSettingWarnings("google", {
      clientId: "shared.apps.googleusercontent.com",
      accounts: { personal: {}, work: { clientId: "" } },
    });
    expect(advisories.map((a) => a.account)).toEqual(["work"]);
    expect(advisories[0]?.message).toContain("[connectors.google.accounts.work]");
  });

  test("accounts inherit the flat keys they do not override", () => {
    expect(
      missingSettingWarnings("ms-graph", {
        tenantId: "t-1",
        clientId: "c-1",
        accounts: { alpha: {}, beta: { user: "someone@example.com" } },
      }),
    ).toEqual([]);
  });

  test("credential probes are per account, with the default one unprefixed", () => {
    expect(accountSecretProbes("google", {})).toEqual([
      { account: null, base: "refreshToken", secret: "refreshToken" },
    ]);
    expect(accountSecretProbes("google", { accounts: { default: {}, work: {} } })).toEqual([
      { account: "default", base: "refreshToken", secret: "refreshToken" },
      { account: "work", base: "refreshToken", secret: "work:refreshToken" },
    ]);
  });

  test("a connector that does not declare multiAccount keeps its base probes", () => {
    // The capability is what the manifest declares, never what a stray config
    // key implies — otherwise a typo'd `accounts` table would silently redirect
    // the credential probe to secrets nothing reads.
    expect(accountSecretProbes("github", { accounts: { work: {} } })).toEqual([
      { account: null, base: "token", secret: "token" },
    ]);
  });

  test("advisoryLabel names the account only once one is declared", () => {
    expect(advisoryLabel("google", null)).toBe("google");
    expect(advisoryLabel("google", "work")).toBe("google (account 'work')");
  });
});

describe("demotedDefaultAccountNotice — the flat slice becoming defaults (ADR-0050)", () => {
  test("silent when there is no accounts table, or when it declares default", () => {
    expect(demotedDefaultAccountNotice("google", { clientId: "c" }, true)).toBeNull();
    expect(
      demotedDefaultAccountNotice("google", { accounts: { default: {}, work: {} } }, true),
    ).toBeNull();
  });

  test("warns when a credential for the unnamed default is still stored", () => {
    const notice = demotedDefaultAccountNotice("google", { accounts: { work: {} } }, true);
    expect(notice?.severity).toBe("warn");
    expect(notice?.message).toContain("no longer synced");
    expect(notice?.message).toContain("[connectors.google.accounts.default]");
  });

  test("only informs when nothing shows the default account ever existed", () => {
    // Without a stored credential, "was ingesting" and "never was" are
    // indistinguishable — so the notice states the rule and asserts nothing
    // about this install's history.
    const notice = demotedDefaultAccountNotice("google", { accounts: { work: {} } }, false);
    expect(notice?.severity).toBe("info");
    expect(notice?.message).not.toContain("no longer synced");
    expect(notice?.message).toContain("inherited defaults");
  });
});
