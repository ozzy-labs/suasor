import { describe, expect, test } from "bun:test";
import { Command, type CommandClass } from "clipanion";
import {
  buildCli,
  isRootHelp,
  registeredCommandClasses,
  setupFirstHelp,
} from "../../src/cli/index.ts";

/**
 * Covers the root-help reorder (#566): clipanion renders general-help
 * categories alphabetically, which buried `Setup` (init / onboard — the first
 * commands every new install needs) ~170 lines below the connector plumbing.
 * `setupFirstHelp()` post-processes clipanion's rendering to hoist the Setup
 * category to the top while leaving everything else byte-identical.
 */

const registry = registeredCommandClasses();

/** Index of the first line containing `needle`, or -1. */
function lineIndexOf(text: string, needle: string): number {
  return text.split("\n").findIndex((line) => line.includes(needle));
}

/** Sorted copy of the text's lines, for order-insensitive equality. */
function sortedLines(text: string): string[] {
  return text.split("\n").toSorted();
}

describe("setupFirstHelp — hoists Setup to the top of the general help", () => {
  for (const colored of [false, true]) {
    test(`Setup renders first (colored: ${colored})`, () => {
      const usage = buildCli(registry).usage(null, { colored });
      const out = setupFirstHelp(usage, registry);

      // Setup now precedes the alphabetically-first category…
      const setupAt = lineIndexOf(out, "Setup");
      const connectorAuthAt = lineIndexOf(out, "Connector auth");
      expect(setupAt).toBeGreaterThan(-1);
      expect(connectorAuthAt).toBeGreaterThan(-1);
      expect(setupAt).toBeLessThan(connectorAuthAt);

      // …and lands right after the banner, before any command usage line.
      expect(setupAt).toBeLessThan(lineIndexOf(out, "suasor box auth set"));
      expect(lineIndexOf(out, "suasor init")).toBeLessThan(connectorAuthAt);
      expect(lineIndexOf(out, "suasor onboard")).toBeLessThan(connectorAuthAt);

      // The banner stays on top.
      expect(lineIndexOf(out, "suasor <command>")).toBeLessThan(setupAt);

      // Pure reorder: the same lines, nothing added, dropped, or rewritten.
      expect(sortedLines(out)).toEqual(sortedLines(usage));

      // The fixed epilogue stays at the very bottom.
      const lines = out.split("\n");
      expect(lineIndexOf(out, "You can also print more details")).toBeGreaterThan(lines.length - 4);
    });
  }

  test("is a no-op when no Setup category exists", () => {
    class LoneCommand extends Command {
      static override paths = [["lone"]];
      static override usage = Command.Usage({
        category: "Zeta",
        description: "A lone command.",
      });
      async execute(): Promise<void> {}
    }
    const commands = [LoneCommand as unknown as CommandClass];
    const usage = buildCli(commands).usage(null, { colored: false });
    expect(setupFirstHelp(usage, commands)).toBe(usage);
  });

  test("detaches the epilogue when Setup sorts last", () => {
    class AlphaCommand extends Command {
      static override paths = [["alpha"]];
      static override usage = Command.Usage({
        category: "Alpha",
        description: "First alphabetically.",
      });
      async execute(): Promise<void> {}
    }
    class SetupCommand extends Command {
      static override paths = [["boot"]];
      static override usage = Command.Usage({
        category: "Setup",
        description: "Sorts last here.",
      });
      async execute(): Promise<void> {}
    }
    const commands = [AlphaCommand, SetupCommand] as unknown as CommandClass[];
    const usage = buildCli(commands).usage(null, { colored: false });
    const out = setupFirstHelp(usage, commands);

    expect(lineIndexOf(out, "Setup")).toBeLessThan(lineIndexOf(out, "Alpha"));
    // The epilogue did not travel with the hoisted Setup block.
    const epilogueAt = lineIndexOf(out, "You can also print more details");
    expect(epilogueAt).toBeGreaterThan(lineIndexOf(out, "Alpha"));
    expect(sortedLines(out)).toEqual(sortedLines(usage));
  });

  test("command descriptions that merely mention a category name are not headers", () => {
    // Indented lines never match, even if they equal a category name.
    const usage = buildCli(registry).usage(null, { colored: false });
    const out = setupFirstHelp(usage, registry);
    // Exactly one Setup header block: init and onboard stay adjacent to it.
    const initAt = lineIndexOf(out, "suasor init");
    const setupAt = lineIndexOf(out, "Setup");
    expect(initAt - setupAt).toBeLessThanOrEqual(3);
  });
});

describe("isRootHelp — classifies exactly the general-help invocations", () => {
  test("bare invocation and root help flags", () => {
    expect(isRootHelp([])).toBe(true);
    expect(isRootHelp(["--help"])).toBe(true);
    expect(isRootHelp(["-h"])).toBe(true);
  });

  test("anything else defers to clipanion", () => {
    expect(isRootHelp(["init"])).toBe(false);
    expect(isRootHelp(["slack", "--help"])).toBe(false);
    expect(isRootHelp(["--version"])).toBe(false);
    expect(isRootHelp(["--help", "extra"])).toBe(false);
  });
});
