/**
 * Pure `[connectors.X]` slice appender (ADR-0029 §3). The wizard's only new side
 * effect is appending a connector slice to config.toml; these tests pin the three
 * load-bearing properties — non-destructive (existing slices/comments preserved),
 * new-append (enabled = true is written), and idempotent — as pure string I/O.
 */
import { describe, expect, test } from "bun:test";
import {
  appendConnectorSlice,
  connectorSliceTemplate,
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
    for (const name of ["github", "slack", "ms-graph", "google", "box", "web", "local"]) {
      expect(connectorSliceTemplate(name).body[0]).toBe("enabled = true");
    }
  });

  test("an unknown connector falls back to an enabled-only slice", () => {
    expect(connectorSliceTemplate("mystery").body).toEqual(["enabled = true"]);
  });
});
