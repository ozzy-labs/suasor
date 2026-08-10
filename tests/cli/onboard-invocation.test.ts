/**
 * Invocation-channel detection + note rendering for the `suasor onboard`
 * scheduler / cron templates (ADR-0029 §5, Issue #293). The argv / execPath are
 * injected so the heuristic is unit-testable without depending on how the test
 * runner itself was launched.
 */
import { describe, expect, test } from "bun:test";
import { detectInvocationChannel, invocationNote } from "../../src/cli/onboard/invocation.ts";
import { mcpInvocationNote, resolveMcpInvocation } from "../../src/cli/onboard/mcp-snippet.ts";

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

  // Issue #558: inside the image the entry is `bun /app/dist/index.js`, which
  // argv/execPath alone would classify as `global` — the env marker wins.
  test("SUASOR_CHANNEL=docker is docker (baked into the image)", () => {
    expect(
      detectInvocationChannel(["bun", "/app/dist/index.js"], "/usr/local/bin/bun", {
        SUASOR_CHANNEL: "docker",
      }),
    ).toBe("docker");
  });

  test("the image's preset SUASOR_CONFIG_DIR=/data is docker (pre-marker images)", () => {
    expect(
      detectInvocationChannel(["bun", "/app/dist/index.js"], "/usr/local/bin/bun", {
        SUASOR_CONFIG_DIR: "/data",
      }),
    ).toBe("docker");
  });

  test("a non-/data SUASOR_CONFIG_DIR does not classify as docker", () => {
    expect(
      detectInvocationChannel(["/usr/local/bin/suasor"], "/usr/local/bin/suasor", {
        SUASOR_CONFIG_DIR: "/home/u/.config/suasor",
      }),
    ).toBe("global");
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

  test("docker points at the host's scheduler (Issue #558)", () => {
    const note = invocationNote("docker");
    expect(note).toContain("Docker container");
    expect(note).toContain("HOST's");
    expect(note).toContain("docker run");
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

  // Issue #558: the HOST spawns the container; `-i` keeps stdin open for the
  // stdio MCP transport (without it the server exits immediately).
  test("docker → host-side docker run -i … mcp serve", () => {
    expect(resolveMcpInvocation("docker", "/ignored")).toEqual({
      command: "docker",
      args: [
        "run",
        "--rm",
        "-i",
        "-v",
        "suasor-data:/data",
        "ghcr.io/ozzy-labs/suasor:latest",
        "mcp",
        "serve",
      ],
    });
  });
});

describe("mcpInvocationNote (Issue #388 item 2)", () => {
  test("global confirms the block is ready to paste as-is", () => {
    const note = mcpInvocationNote("global");
    expect(note).toContain("ready to use as-is");
    // The MCP block already renders `suasor`, so the note must NOT tell the user
    // to replace it (that is the scheduler note's job).
    expect(note.toLowerCase()).not.toContain("replace");
  });

  test("from-source explains the block already uses the resolved bun invocation", () => {
    const note = mcpInvocationNote("from-source");
    expect(note).toContain("already uses");
    expect(note).toContain("bun run");
    expect(note.toLowerCase()).not.toContain("replace `suasor`");
  });

  test("bunx explains the block already uses the bunx invocation", () => {
    const note = mcpInvocationNote("bunx");
    expect(note).toContain("already uses");
    expect(note).toContain("bunx suasor");
  });

  test("docker explains the block already uses the host-side docker run form", () => {
    const note = mcpInvocationNote("docker");
    expect(note).toContain("already uses");
    expect(note).toContain("docker run -i");
    expect(note).toContain("HOST's");
  });
});
