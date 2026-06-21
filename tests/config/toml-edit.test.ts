/**
 * Surgical TOML edits for validate-config --fix (Issue #280). Asserts removals
 * keep comments/formatting and that the result re-parses to the expected tree.
 */
import { describe, expect, test } from "bun:test";
import { removeArrayElement, removeKeyLine } from "../../src/config/toml-edit.ts";

/** Parse TOML text and read the local connector's `roots` array. */
function parseLocalRoots(text: string): unknown {
  const parsed = Bun.TOML.parse(text) as {
    connectors?: { local?: { roots?: unknown } };
  };
  return parsed.connectors?.local?.roots;
}

describe("removeKeyLine", () => {
  test("removes a single key line within its section, keeping comments", () => {
    const toml = `# header
[connectors.github]
repo = ["a/b"]   # typo
repos = ["x/y"]
`;
    const r = removeKeyLine(toml, "connectors.github.repo");
    expect(r.changed).toBe(true);
    expect(r.text).toContain("# header");
    expect(r.text).toContain('repos = ["x/y"]');
    expect(r.text).not.toContain("repo = ");
  });

  test("removes a multi-line array value in full", () => {
    const toml = `[connectors.local]
bogus = [
  "one",
  "two",
]
roots = ["/tmp"]
`;
    const r = removeKeyLine(toml, "connectors.local.bogus");
    expect(r.changed).toBe(true);
    expect(r.text).not.toContain("bogus");
    expect(r.text).not.toContain('"one"');
    expect(r.text).toContain('roots = ["/tmp"]');
    expect(() => Bun.TOML.parse(r.text)).not.toThrow();
  });

  test("does not touch a same-named key in another section", () => {
    const toml = `[connectors.github]
repos = ["a/b"]
[connectors.other]
repos = ["c/d"]
`;
    const r = removeKeyLine(toml, "connectors.github.repos");
    expect(r.changed).toBe(true);
    const parsed = Bun.TOML.parse(r.text) as {
      connectors?: { github?: { repos?: unknown }; other?: { repos?: unknown } };
    };
    expect(parsed.connectors?.github?.repos).toBeUndefined();
    expect(parsed.connectors?.other?.repos).toEqual(["c/d"]);
  });

  test("no-op when the key is absent", () => {
    const toml = `[connectors.github]\nrepos = []\n`;
    const r = removeKeyLine(toml, "connectors.github.nope");
    expect(r.changed).toBe(false);
    expect(r.text).toBe(toml);
  });

  test("a scalar string value containing '[' does not swallow following lines", () => {
    // The removed key's value is a scalar string with a stray '[' and no ']'.
    // Only that one line must be dropped — the following key must survive.
    const toml = `[connectors.github]
bogus = "weird[value"
repos = ["a/b"]
`;
    const r = removeKeyLine(toml, "connectors.github.bogus");
    expect(r.changed).toBe(true);
    expect(r.text).not.toContain("bogus");
    expect(r.text).toContain('repos = ["a/b"]'); // not swallowed
    expect(() => Bun.TOML.parse(r.text)).not.toThrow();
  });
});

describe("removeArrayElement", () => {
  test("removes a multi-line array element by value", () => {
    const toml = `[connectors.local]
roots = [
  "/missing",
  "/tmp",
]
`;
    const r = removeArrayElement(toml, "connectors.local.roots", "/missing");
    expect(r.changed).toBe(true);
    expect(parseLocalRoots(r.text)).toEqual(["/tmp"]);
  });

  test("removes an inline array element by value", () => {
    const toml = `[connectors.local]\nroots = ["/missing", "/tmp"]\n`;
    const r = removeArrayElement(toml, "connectors.local.roots", "/missing");
    expect(r.changed).toBe(true);
    expect(parseLocalRoots(r.text)).toEqual(["/tmp"]);
  });

  test("no-op when the element is absent", () => {
    const toml = `[connectors.local]\nroots = ["/tmp"]\n`;
    const r = removeArrayElement(toml, "connectors.local.roots", "/missing");
    expect(r.changed).toBe(false);
  });
});
