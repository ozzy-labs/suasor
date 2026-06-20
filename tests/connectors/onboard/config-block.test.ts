/**
 * Shared discovery config-block renderer (ADR-0030). Pure string-out: header,
 * load-bearing `enabled = true`, extras, the id array with label comments, and
 * the empty-array path.
 */
import { describe, expect, test } from "bun:test";
import { renderConnectorConfigBlock } from "../../../src/connectors/onboard/config-block.ts";

describe("renderConnectorConfigBlock", () => {
  test("renders header + enabled + array with label comments", () => {
    const lines = renderConnectorConfigBlock(
      "github",
      [
        { value: "o/a", label: "public" },
        { value: "o/b", label: "private" },
      ],
      { key: "repos", idNote: "repos are full names" },
    );
    expect(lines[0]).toBe("[connectors.github]");
    expect(lines[1]).toBe("enabled = true");
    expect(lines).toContain("# repos are full names");
    expect(lines).toContain("repos = [");
    expect(lines).toContain('  "o/a",  # public');
    expect(lines).toContain('  "o/b",  # private');
    expect(lines[lines.length - 1]).toBe("]");
  });

  test("emits extras between enabled and the array, in order", () => {
    const lines = renderConnectorConfigBlock("slack", [{ value: "C1", label: "#general" }], {
      key: "channels",
      extras: ['team = "T1"'],
    });
    expect(lines[1]).toBe("enabled = true");
    expect(lines[2]).toBe('team = "T1"');
    expect(lines).toContain("channels = [");
  });

  test("renders an empty array (key = []) when there are no entries", () => {
    const lines = renderConnectorConfigBlock("github", [], { key: "repos" });
    expect(lines).toEqual(["[connectors.github]", "enabled = true", "repos = []"]);
  });

  test("omits the trailing comment when an entry has no label", () => {
    const lines = renderConnectorConfigBlock("github", [{ value: "o/a" }], { key: "repos" });
    expect(lines).toContain('  "o/a",');
  });
});
