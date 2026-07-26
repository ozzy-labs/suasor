/**
 * Pure `[connectors.X]` slice appender (ADR-0029 §3). The wizard's only new side
 * effect is appending a connector slice to config.toml; these tests pin the three
 * load-bearing properties — non-destructive (existing slices/comments preserved),
 * new-append (enabled = true is written), and idempotent — as pure string I/O.
 */
import { describe, expect, test } from "bun:test";
import {
  accountBodyFromBlock,
  appendConnectorAccountSlice,
  appendConnectorBlock,
  appendConnectorSlice,
  connectorAccountTemplate,
  connectorDefaultAccountTemplate,
  connectorSliceTemplate,
  hasConnectorAccountSlice,
  hasConnectorSlice,
} from "../../src/cli/onboard/config-append.ts";

describe("appendConnectorSlice — new append", () => {
  test("appends [connectors.github] with enabled = true to an empty file", () => {
    const { toml, appended } = appendConnectorSlice("", "github");
    expect(appended).toBe(true);
    expect(toml).toContain("[connectors.github]");
    expect(toml).toContain("enabled = true");
    expect(toml.endsWith("\n")).toBe(true);
  });

  test("separates the new slice from prior content with a blank line", () => {
    const base = "[storage]\n# dbPath = ...\n";
    const { toml, appended } = appendConnectorSlice(base, "slack");
    expect(appended).toBe(true);
    expect(toml).toContain("[storage]");
    expect(toml).toContain("\n\n[connectors.slack]");
  });

  test("emits connector-specific placeholder keys as comments", () => {
    const { toml } = appendConnectorSlice("", "github");
    expect(toml).toContain("# repos =");
  });
});

describe("appendConnectorSlice — non-destructive + idempotent", () => {
  test("leaves an existing [connectors.github] untouched (idempotent)", () => {
    const base = '[connectors.github]\nenabled = true\nrepos = ["a/b"]\n';
    const { toml, appended } = appendConnectorSlice(base, "github");
    expect(appended).toBe(false);
    expect(toml).toBe(base);
  });

  test("does NOT re-enable a connector the user set enabled = false", () => {
    const base = "[connectors.slack]\nenabled = false\n";
    const { toml, appended } = appendConnectorSlice(base, "slack");
    expect(appended).toBe(false);
    expect(toml).toBe(base);
    expect(toml).not.toContain("enabled = true");
  });

  test("preserves hand-written comments and other sections", () => {
    const base = '# my notes\n[storage]\ndbPath = "/x"\n\n[embedding]\nbackend = "ollama"\n';
    const { toml } = appendConnectorSlice(base, "box");
    expect(toml).toContain("# my notes");
    expect(toml).toContain('backend = "ollama"');
    expect(toml).toContain("[connectors.box]");
  });

  test("running twice is stable (append then no-op)", () => {
    const first = appendConnectorSlice("", "web");
    expect(first.appended).toBe(true);
    const second = appendConnectorSlice(first.toml, "web");
    expect(second.appended).toBe(false);
    expect(second.toml).toBe(first.toml);
  });

  test("a commented-out header does not count as an existing slice", () => {
    const base = "# [connectors.github]\n";
    const { appended } = appendConnectorSlice(base, "github");
    expect(appended).toBe(true);
  });
});

describe("appendConnectorBlock — discovery-rendered block (ADR-0030, Issue #195)", () => {
  const block = [
    "[connectors.github]",
    "enabled = true",
    "repos = [",
    '  "acme/api",  # private',
    "]",
  ];

  test("appends a pre-rendered block verbatim to an empty file", () => {
    const { toml, appended } = appendConnectorBlock("", "github", block);
    expect(appended).toBe(true);
    expect(toml).toContain("[connectors.github]");
    expect(toml).toContain('"acme/api"');
    expect(toml).toContain("repos = [");
    expect(toml.endsWith("\n")).toBe(true);
  });

  test("separates the block from prior content with a single blank line", () => {
    const { toml } = appendConnectorBlock("[storage]\n", "github", block);
    expect(toml).toContain("\n\n[connectors.github]");
  });

  test("is non-destructive: an existing slice is left untouched", () => {
    const base = "[connectors.github]\nenabled = false\n";
    const { toml, appended } = appendConnectorBlock(base, "github", block);
    expect(appended).toBe(false);
    expect(toml).toBe(base);
    expect(toml).not.toContain('"acme/api"');
  });
});

describe("hasConnectorSlice", () => {
  test("matches the exact header, tolerating an inline comment", () => {
    expect(hasConnectorSlice("[connectors.github] # ingest issues\n", "github")).toBe(true);
    expect(hasConnectorSlice("[connectors.github]\n", "github")).toBe(true);
  });

  test("does not match a nested workspace table", () => {
    expect(hasConnectorSlice("[connectors.slack.workspaces.foo]\n", "slack")).toBe(false);
  });

  test("does not match a different connector", () => {
    expect(hasConnectorSlice("[connectors.github]\n", "slack")).toBe(false);
  });
});

describe("connectorSliceTemplate", () => {
  test("every template includes enabled = true as the first body line", () => {
    for (const name of [
      "github",
      "slack",
      "ms-graph",
      "google",
      "box",
      "notion",
      "jira",
      "web",
      "local",
    ]) {
      expect(connectorSliceTemplate(name).body[0]).toBe("enabled = true");
    }
  });

  test("box template uses the real `folders` key (not the legacy `folderId`)", () => {
    const body = connectorSliceTemplate("box").body.join("\n");
    expect(body).toContain("# folders =");
    expect(body).not.toContain("folderId");
  });

  test("notion template hints databases + pages placeholder keys", () => {
    const body = connectorSliceTemplate("notion").body.join("\n");
    expect(body).toContain("# databases =");
    expect(body).toContain("# pages =");
  });

  test("jira template hints host / email / projects placeholder keys", () => {
    const body = connectorSliceTemplate("jira").body.join("\n");
    expect(body).toContain("# host =");
    expect(body).toContain("# email =");
    expect(body).toContain("# projects =");
  });

  test("an unknown connector falls back to an enabled-only slice", () => {
    expect(connectorSliceTemplate("mystery").body).toEqual(["enabled = true"]);
  });
});

/**
 * Per-account tables (ADR-0050, Issue #538): the same three properties one level
 * down, plus the one thing the account table must *not* carry.
 */
describe("appendConnectorAccountSlice — per-account table", () => {
  test("appends [connectors.box.accounts.work] with the given body", () => {
    const base = "[connectors.box]\nenabled = true\n";
    const { toml, appended } = appendConnectorAccountSlice(base, "box", "work", ["# note"]);
    expect(appended).toBe(true);
    expect(toml).toContain("\n\n[connectors.box.accounts.work]\n# note\n");
    // The connector's own slice is untouched.
    expect(toml).toContain("[connectors.box]\nenabled = true\n");
  });

  test("leaves an account the operator already wrote untouched (idempotent)", () => {
    const base = '[connectors.box.accounts.work]\nfolders = ["9911"]\n';
    const { toml, appended } = appendConnectorAccountSlice(base, "box", "work", ["# note"]);
    expect(appended).toBe(false);
    expect(toml).toBe(base);
  });

  test("a different account's table does not count as this one's", () => {
    const base = "[connectors.box.accounts.personal]\n";
    expect(hasConnectorAccountSlice(base, "box", "personal")).toBe(true);
    expect(hasConnectorAccountSlice(base, "box", "work")).toBe(false);
    // ... and the flat check still does not match a nested table (unchanged).
    expect(hasConnectorSlice(base, "box")).toBe(false);
  });
});

describe("accountBodyFromBlock — discovery block → account table body", () => {
  test("drops the flat header and keeps the discovered ids", () => {
    const block = ["[connectors.box]", "enabled = true", "folders = [", '  "9911",', "]"];
    expect(accountBodyFromBlock("box", block)).toEqual(["folders = [", '  "9911",', "]"]);
  });

  test("drops `enabled`, which is read per connector and never per account", () => {
    // A per-account `enabled` would be a key an operator can set and nothing
    // reads — `selectEnabledConnectors` only ever looks at the connector level.
    const body = accountBodyFromBlock("google", ["[connectors.google]", "enabled  =  false"]);
    expect(body).toEqual([]);
  });
});

describe("account table templates", () => {
  test("the fallback template warns that inherited scope ids are another account's", () => {
    const body = connectorAccountTemplate("box").join("\n");
    expect(body).toContain("[connectors.box]");
    expect(body).toContain("account-relative");
    // Comments only: the wizard never guesses this account's ingest scope.
    expect(connectorAccountTemplate("box").every((line) => line.startsWith("#"))).toBe(true);
  });

  test("the preserved-default template is comments only (it inherits everything)", () => {
    const lines = connectorDefaultAccountTemplate("google");
    expect(lines.every((line) => line.startsWith("#"))).toBe(true);
    expect(lines.join("\n")).toContain("[connectors.google]");
  });
});
