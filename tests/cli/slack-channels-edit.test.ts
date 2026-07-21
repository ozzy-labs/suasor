/**
 * Surgical `[connectors.slack].channels` edits (`slack follow` / `unfollow`,
 * ADR-0042 決定 6). Pure text-level tests: comments and unrelated sections must
 * survive every edit, and the result must round-trip as TOML.
 */
import { describe, expect, test } from "bun:test";
import { addSlackChannels, removeSlackChannels } from "../../src/cli/slack-channels-edit.ts";

const BASE = `# my config
[storage]
# dbPath = "/tmp/db"

[connectors.slack]
enabled = true
# channels are ids
channels = [
  "C1",  # #general
  "C2",  # #random
]
since = "30d"

[connectors.github]
repos = ["o/r"]
`;

describe("addSlackChannels", () => {
  test("appends new ids before the closer, preserving existing lines + comments", () => {
    const { toml, added, already } = addSlackChannels(BASE, [
      { id: "C3", label: "#eng" },
      { id: "C1" }, // already configured → skipped
    ]);
    expect(added).toEqual(["C3"]);
    expect(already).toEqual(["C1"]);
    expect(toml).toContain('  "C3",  # #eng');
    expect(toml).toContain('  "C1",  # #general'); // untouched, comment intact
    expect(toml).toContain('since = "30d"');
    expect(toml).toContain("[connectors.github]");
    const parsed = Bun.TOML.parse(toml) as {
      connectors: { slack: { channels: string[] } };
    };
    expect(parsed.connectors.slack.channels).toEqual(["C1", "C2", "C3"]);
  });

  test("converts a single-line array to multi-line on first edit", () => {
    const single = '[connectors.slack]\nchannels = ["C1", "C2"]\n';
    const { toml, added } = addSlackChannels(single, [{ id: "C3", label: "#x" }]);
    expect(added).toEqual(["C3"]);
    const parsed = Bun.TOML.parse(toml) as { connectors: { slack: { channels: string[] } } };
    expect(parsed.connectors.slack.channels).toEqual(["C1", "C2", "C3"]);
  });

  test("creates the channels key when the section has none", () => {
    const noKey = "[connectors.slack]\nenabled = true\n";
    const { toml, added } = addSlackChannels(noKey, [{ id: "C9" }]);
    expect(added).toEqual(["C9"]);
    const parsed = Bun.TOML.parse(toml) as { connectors: { slack: { channels: string[] } } };
    expect(parsed.connectors.slack.channels).toEqual(["C9"]);
  });

  test("creates the whole section when config has no [connectors.slack]", () => {
    const none = "[storage]\n";
    const { toml, added } = addSlackChannels(none, [{ id: "C9", label: "#new" }]);
    expect(added).toEqual(["C9"]);
    const parsed = Bun.TOML.parse(toml) as {
      connectors: { slack: { enabled: boolean; channels: string[] } };
    };
    expect(parsed.connectors.slack.enabled).toBe(true);
    expect(parsed.connectors.slack.channels).toEqual(["C9"]);
  });

  test("does not confuse a sub-table with the flat section", () => {
    // channel_since is a sub-table AFTER the section; the channels array must be
    // created inside [connectors.slack], not inside the sub-table.
    const withSub = "[connectors.slack]\nenabled = true\n[connectors.slack.channel_since]\n";
    const { toml } = addSlackChannels(withSub, [{ id: "C9" }]);
    const parsed = Bun.TOML.parse(toml) as {
      connectors: { slack: { channels: string[]; channel_since?: unknown } };
    };
    expect(parsed.connectors.slack.channels).toEqual(["C9"]);
  });

  test("all ids already present → no change", () => {
    const { toml, added, already } = addSlackChannels(BASE, [{ id: "C1" }, { id: "C2" }]);
    expect(added).toEqual([]);
    expect(already).toEqual(["C1", "C2"]);
    expect(toml).toBe(BASE);
  });
});

describe("removeSlackChannels", () => {
  test("drops the entry line (comment included), keeps the rest verbatim", () => {
    const { toml, removed, missing } = removeSlackChannels(BASE, ["C1", "C9"]);
    expect(removed).toEqual(["C1"]);
    expect(missing).toEqual(["C9"]);
    expect(toml).not.toContain('"C1"');
    expect(toml).not.toContain("#general");
    expect(toml).toContain('  "C2",  # #random');
    const parsed = Bun.TOML.parse(toml) as { connectors: { slack: { channels: string[] } } };
    expect(parsed.connectors.slack.channels).toEqual(["C2"]);
  });

  test("single-line array keeps the survivors", () => {
    const single = '[connectors.slack]\nchannels = ["C1", "C2", "C3"]\n';
    const { toml, removed } = removeSlackChannels(single, ["C2"]);
    expect(removed).toEqual(["C2"]);
    const parsed = Bun.TOML.parse(toml) as { connectors: { slack: { channels: string[] } } };
    expect(parsed.connectors.slack.channels).toEqual(["C1", "C3"]);
  });

  test("no section / no key → everything missing, config untouched", () => {
    expect(removeSlackChannels("[storage]\n", ["C1"])).toEqual({
      toml: "[storage]\n",
      removed: [],
      missing: ["C1"],
    });
    expect(removeSlackChannels("[connectors.slack]\nenabled = true\n", ["C1"]).missing).toEqual([
      "C1",
    ]);
  });
});
