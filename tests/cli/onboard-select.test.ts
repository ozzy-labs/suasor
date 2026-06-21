/**
 * Pure connector-selection resolver for the `suasor onboard` interactive prompt
 * (ADR-0029 §2, Issue #293). The TTY prompt is split into a pure
 * candidates → selection resolver so the parsing/validation is unit-testable
 * with injected input (no real TTY).
 */
import { describe, expect, test } from "bun:test";
import { renderConnectorMenu, resolveSelection } from "../../src/cli/onboard/select.ts";

const CANDIDATES = ["github", "slack", "box", "web"] as const;

describe("resolveSelection — numbers and names", () => {
  test("a single 1-based index resolves to the connector", () => {
    expect(resolveSelection("1", CANDIDATES)).toEqual({ connectors: ["github"] });
  });

  test("a single name resolves to itself", () => {
    expect(resolveSelection("slack", CANDIDATES)).toEqual({ connectors: ["slack"] });
  });

  test("comma-separated numbers resolve in input order", () => {
    expect(resolveSelection("1,3", CANDIDATES)).toEqual({ connectors: ["github", "box"] });
  });

  test("space-separated names resolve in input order", () => {
    expect(resolveSelection("github slack", CANDIDATES)).toEqual({
      connectors: ["github", "slack"],
    });
  });

  test("mixed numbers and names are supported", () => {
    expect(resolveSelection("2, web", CANDIDATES)).toEqual({ connectors: ["slack", "web"] });
  });

  test("duplicates (number + matching name) are deduped, first wins", () => {
    expect(resolveSelection("1 github", CANDIDATES)).toEqual({ connectors: ["github"] });
  });
});

describe("resolveSelection — validation (no silent wrong answer)", () => {
  test("an empty selection is an error", () => {
    const r = resolveSelection("   ", CANDIDATES);
    expect("error" in r && r.error).toContain("no connector selected");
  });

  test("an out-of-range index is an error", () => {
    const r = resolveSelection("9", CANDIDATES);
    expect("error" in r && r.error).toContain("out of range");
  });

  test("an unknown name is an error listing the known set", () => {
    const r = resolveSelection("nope", CANDIDATES);
    expect("error" in r && r.error).toContain("unknown connector: nope");
    expect("error" in r && r.error).toContain("github");
  });
});

describe("renderConnectorMenu", () => {
  test("renders a 1-based numbered menu of the candidates", () => {
    const menu = renderConnectorMenu(CANDIDATES);
    expect(menu).toContain("1) github");
    expect(menu).toContain("4) web");
    expect(menu).toContain("Select connector(s)");
  });
});
