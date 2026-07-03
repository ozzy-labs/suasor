import { describe, expect, test } from "bun:test";
import { Command, type CommandClass } from "clipanion";
import { categoryHelp, registeredCommandClasses } from "../../src/cli/index.ts";

/**
 * Covers the `suasor <category-verb> --help` interceptor (#395): a bare
 * `--help`/`-h` on a verb prefix shared by several commands renders a readable
 * subcommand listing instead of clipanion's "Multiple commands match" output,
 * while every other help shape is left untouched (regression-critical).
 */

const registry = registeredCommandClasses();

describe("categoryHelp — fires on a shared verb prefix", () => {
  test("`slack --help` lists every slack subcommand with summaries", () => {
    const out = categoryHelp(["slack", "--help"], registry, "suasor");
    expect(out).not.toBeNull();
    const text = out as string;
    expect(text).toContain("Subcommands for `suasor slack`:");
    // Derived from the registry, not hand-maintained — all slack verbs appear.
    for (const command of [
      "suasor slack sync",
      "suasor slack auth set",
      "suasor slack auth test",
      "suasor slack conversations",
      "suasor slack status",
      "suasor slack cursor reset",
      "suasor slack cursor backfill",
      "suasor slack resolve-names",
    ]) {
      expect(text).toContain(command);
    }
    // A summary is rendered next to each command (em-dash separator).
    expect(text).toContain("— Ingest sources from slack (read-only).");
    // Footer points at the per-command detailed help.
    expect(text).toContain("Run `suasor slack <subcommand> --help`");
    // Never the clipanion ambiguous framing.
    expect(text).not.toContain("Multiple commands match");
    expect(text).not.toContain("-h=<index>");
  });

  test("the `-h` short flag behaves like `--help`", () => {
    const long = categoryHelp(["slack", "--help"], registry, "suasor");
    const short = categoryHelp(["slack", "-h"], registry, "suasor");
    expect(short).toEqual(long);
  });

  test("a deeper prefix lists only that branch (`slack cursor`)", () => {
    const text = categoryHelp(["slack", "cursor", "--help"], registry, "suasor") as string;
    expect(text).not.toBeNull();
    expect(text).toContain("Subcommands for `suasor slack cursor`:");
    expect(text).toContain("suasor slack cursor reset");
    expect(text).toContain("suasor slack cursor backfill");
    // Sibling branches outside the prefix are excluded.
    expect(text).not.toContain("suasor slack sync");
    expect(text).not.toContain("suasor slack status");
  });

  test("another verb group also works (`config`)", () => {
    const text = categoryHelp(["config", "--help"], registry, "suasor") as string;
    expect(text).toContain("Subcommands for `suasor config`:");
    expect(text).toContain("suasor config show");
    expect(text).toContain("suasor config edit");
  });

  test("subcommands are sorted and de-duplicated", () => {
    const text = categoryHelp(["slack", "--help"], registry, "suasor") as string;
    const rows = text
      .split("\n")
      .filter((line) => line.startsWith("  suasor "))
      .map((line) => line.trim());
    const sorted = [...rows].sort((a, b) => a.localeCompare(b));
    expect(rows).toEqual(sorted);
    expect(new Set(rows).size).toBe(rows.length);
  });
});

describe("categoryHelp — defers to clipanion (regression-critical)", () => {
  test("root `--help` is left to clipanion's general help", () => {
    expect(categoryHelp(["--help"], registry, "suasor")).toBeNull();
    expect(categoryHelp(["-h"], registry, "suasor")).toBeNull();
  });

  test("a complete command's `--help` is left to clipanion's detailed help", () => {
    expect(categoryHelp(["slack", "sync", "--help"], registry, "suasor")).toBeNull();
    expect(categoryHelp(["slack", "sync", "-h"], registry, "suasor")).toBeNull();
    expect(categoryHelp(["slack", "status", "--help"], registry, "suasor")).toBeNull();
  });

  test("an invocation carrying other options is not a bare category help", () => {
    expect(categoryHelp(["slack", "status", "--json"], registry, "suasor")).toBeNull();
    expect(categoryHelp(["slack", "--help", "--json"], registry, "suasor")).toBeNull();
    // `-h=<index>` is clipanion's index selector, not a bare help flag.
    expect(categoryHelp(["slack", "-h=0"], registry, "suasor")).toBeNull();
  });

  test("no help flag at all defers", () => {
    expect(categoryHelp(["slack"], registry, "suasor")).toBeNull();
    expect(categoryHelp(["slack", "sync"], registry, "suasor")).toBeNull();
  });

  test("an unknown verb has no subcommands to list", () => {
    expect(categoryHelp(["bogus", "--help"], registry, "suasor")).toBeNull();
  });
});

describe("categoryHelp — edge cases (synthetic registry)", () => {
  const make = (paths: string[][], description?: string): CommandClass => {
    const Sub = class extends Command {
      static override paths = paths;
      static override usage = description ? Command.Usage({ description }) : undefined;
      async execute() {
        return 0;
      }
    };
    return Sub as unknown as CommandClass;
  };

  test("a prefix with a single subcommand resolves uniquely (no interception)", () => {
    const commands = [make([["solo", "only"]], "the only one")];
    expect(categoryHelp(["solo", "--help"], commands, "suasor")).toBeNull();
  });

  test("a prefix shared by two commands is intercepted", () => {
    const commands = [make([["grp", "a"]], "verb a"), make([["grp", "b"]], "verb b")];
    const text = categoryHelp(["grp", "--help"], commands, "suasor") as string;
    expect(text).toContain("suasor grp a");
    expect(text).toContain("suasor grp b");
  });

  test("commands without a usage description still list (no summary column)", () => {
    const commands = [make([["grp", "a"]]), make([["grp", "b"]])];
    const text = categoryHelp(["grp", "--help"], commands, "suasor") as string;
    expect(text).toContain("suasor grp a");
    expect(text).toContain("suasor grp b");
    expect(text).not.toContain("—");
  });
});
