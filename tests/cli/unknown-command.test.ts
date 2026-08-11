/**
 * Covers the unknown-top-level-command interceptor (Issue #572): a mistyped
 * first token gets a short "did you mean" list of the closest registered
 * commands by edit distance, instead of clipanion's ~75-line full command dump.
 * Every valid or option-first invocation is left for clipanion untouched
 * (regression-critical, same contract as the `categoryHelp()` interceptor).
 */
import { describe, expect, test } from "bun:test";
import { registeredCommandClasses, unknownCommandHelp } from "../../src/cli/index.ts";

const registry = registeredCommandClasses();

describe("unknownCommandHelp — fires on an unknown first token", () => {
  test("a close typo suggests the intended command", () => {
    const out = unknownCommandHelp(["serch", "rocket"], registry, "suasor");
    expect(out).not.toBeNull();
    const text = out as string;
    expect(text).toContain("error: unknown command 'serch'");
    expect(text).toContain("Did you mean:");
    expect(text).toContain("  suasor search");
    expect(text).toContain("Run `suasor --help` for the full command list.");
  });

  test("at most 3 suggestions are shown, closest first", () => {
    const out = unknownCommandHelp(["confg"], registry, "suasor");
    expect(out).not.toBeNull();
    const text = out as string;
    const suggestions = text.split("\n").filter((line) => line.startsWith("  suasor "));
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.length).toBeLessThanOrEqual(3);
    expect(suggestions[0]).toBe("  suasor config");
  });

  test("garbage gets the error but no absurd guesses", () => {
    const out = unknownCommandHelp(["zzqzzq"], registry, "suasor");
    expect(out).not.toBeNull();
    const text = out as string;
    expect(text).toContain("error: unknown command 'zzqzzq'");
    expect(text).not.toContain("Did you mean:");
    expect(text).toContain("Run `suasor --help`");
  });

  test("never renders the full-registry dump framing", () => {
    const text = unknownCommandHelp(["serch"], registry, "suasor") as string;
    expect(text).not.toContain("did you mean one of");
    // Far fewer lines than the registered command count (~75-line dump).
    expect(text.split("\n").length).toBeLessThan(12);
  });
});

describe("unknownCommandHelp — defers every other shape to clipanion", () => {
  test("a known first token defers (single- and multi-segment)", () => {
    expect(unknownCommandHelp(["search", "rocket"], registry, "suasor")).toBeNull();
    expect(unknownCommandHelp(["config", "validate"], registry, "suasor")).toBeNull();
    expect(unknownCommandHelp(["validate-config"], registry, "suasor")).toBeNull();
  });

  test("a known first token with an unknown second token defers (clipanion scopes the error)", () => {
    expect(unknownCommandHelp(["config", "edti"], registry, "suasor")).toBeNull();
  });

  test("option-first invocations defer (help / version builtins)", () => {
    expect(unknownCommandHelp(["--help"], registry, "suasor")).toBeNull();
    expect(unknownCommandHelp(["-h"], registry, "suasor")).toBeNull();
    expect(unknownCommandHelp(["--version"], registry, "suasor")).toBeNull();
  });

  test("an empty argv (root help) defers", () => {
    expect(unknownCommandHelp([], registry, "suasor")).toBeNull();
  });
});
