/**
 * Invocation-channel detection + note rendering for the `suasor onboard`
 * scheduler / cron templates (ADR-0029 §5, Issue #293). The argv / execPath are
 * injected so the heuristic is unit-testable without depending on how the test
 * runner itself was launched.
 */
import { describe, expect, test } from "bun:test";
import { detectInvocationChannel, invocationNote } from "../../src/cli/onboard/invocation.ts";
import { resolveMcpInvocation } from "../../src/cli/onboard/mcp-snippet.ts";

describe("detectInvocationChannel", () => {
  test("a .ts entry point is from-source", () => {
    expect(detectInvocationChannel(["bun", "/repo/src/index.ts"], "/usr/bin/bun")).toBe(
      "from-source",
    );
  });

  test("a bunx cache entry is bunx", () => {
    expect(
      detectInvocationChannel(["bun", "/home/u/.bun/install/cache/suasor/bin.js"], "/usr/bin/bun"),
    ).toBe("bunx");
  });

  test("a real binary on PATH is global", () => {
    expect(detectInvocationChannel(["/usr/local/bin/suasor"], "/usr/local/bin/suasor")).toBe(
      "global",
    );
  });
});

describe("invocationNote", () => {
  test("global confirms the template is ready as-is", () => {
    expect(invocationNote("global")).toContain("ready to use as-is");
  });

  test("from-source warns that suasor is not on PATH", () => {
    const note = invocationNote("from-source");
    expect(note).toContain("not on PATH");
    expect(note).toContain("bun run");
  });

  test("bunx suggests the bunx invocation", () => {
    const note = invocationNote("bunx");
    expect(note).toContain("not on PATH");
    expect(note).toContain("bunx suasor");
  });
});

describe("resolveMcpInvocation (Issue #388 item 2)", () => {
  test("global → suasor mcp serve", () => {
    expect(resolveMcpInvocation("global", "/ignored")).toEqual({
      command: "suasor",
      args: ["mcp", "serve"],
    });
  });

  test("from-source → bun run <entry> mcp serve", () => {
    expect(resolveMcpInvocation("from-source", "/repo/src/index.ts")).toEqual({
      command: "bun",
      args: ["run", "/repo/src/index.ts", "mcp", "serve"],
    });
  });

  test("bunx → bunx suasor mcp serve", () => {
    expect(resolveMcpInvocation("bunx", "/ignored")).toEqual({
      command: "bunx",
      args: ["suasor", "mcp", "serve"],
    });
  });
});
