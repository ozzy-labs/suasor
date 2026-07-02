/**
 * OS-injected scheduler snippet rendering (ADR-0029 §5). The OS is a parameter,
 * so every branch is testable without depending on the real process.platform.
 */
import { describe, expect, test } from "bun:test";
import { renderMcpSnippet } from "../../src/cli/onboard/mcp-snippet.ts";
import {
  renderSchedulerSnippet,
  schedulerKindForPlatform,
} from "../../src/cli/onboard/scheduler.ts";

describe("schedulerKindForPlatform", () => {
  test("darwin → launchd", () => {
    expect(schedulerKindForPlatform("darwin")).toBe("launchd");
  });

  test("linux → systemd", () => {
    expect(schedulerKindForPlatform("linux")).toBe("systemd");
  });

  test("win32 → cron (placeholder)", () => {
    expect(schedulerKindForPlatform("win32")).toBe("cron");
  });
});

describe("renderSchedulerSnippet — per OS", () => {
  test("macOS renders a launchd plist with the sync argv", () => {
    const { kind, snippet } = renderSchedulerSnippet("darwin", "/usr/local/bin/suasor");
    expect(kind).toBe("launchd");
    expect(snippet).toContain("<plist");
    expect(snippet).toContain("com.suasor.sync");
    expect(snippet).toContain("<string>/usr/local/bin/suasor</string>");
    expect(snippet).toContain("<string>sync</string>");
  });

  test("linux renders a systemd service + timer with ExecStart", () => {
    const { kind, snippet } = renderSchedulerSnippet("linux", "suasor");
    expect(kind).toBe("systemd");
    expect(snippet).toContain("ExecStart=suasor sync --json");
    expect(snippet).toContain("OnCalendar=hourly");
    expect(snippet).toContain("WantedBy=timers.target");
  });

  test("windows renders the cron fallback line", () => {
    const { kind, snippet } = renderSchedulerSnippet("win32", "suasor");
    expect(kind).toBe("cron");
    expect(snippet).toContain("15 * * * * suasor --json");
  });

  test("an explicit kind override wins over the OS default", () => {
    const { kind, snippet } = renderSchedulerSnippet("darwin", "suasor", "cron");
    expect(kind).toBe("cron");
    expect(snippet).toContain("15 * * * *");
  });

  test("the label is reported for --json/human output", () => {
    expect(renderSchedulerSnippet("linux", "suasor").label).toContain("systemd");
  });
});

describe("renderMcpSnippet", () => {
  test("renders a claude_desktop_config.json mcpServers block (global invocation)", () => {
    const snippet = renderMcpSnippet({ command: "suasor", args: ["mcp", "serve"] });
    expect(snippet).toContain('"mcpServers"');
    expect(snippet).toContain('"command": "suasor"');
    expect(snippet).toContain('"args": ["mcp", "serve"]');
  });

  test("renders a from-source invocation (bun run <abs> mcp serve)", () => {
    const snippet = renderMcpSnippet({
      command: "bun",
      args: ["run", "/repo/src/index.ts", "mcp", "serve"],
    });
    expect(snippet).toContain('"command": "bun"');
    expect(snippet).toContain('"args": ["run", "/repo/src/index.ts", "mcp", "serve"]');
  });

  test("JSON-encodes special characters (Windows path backslashes stay valid)", () => {
    const snippet = renderMcpSnippet({
      command: "bun",
      args: ["run", "C:\\repo\\src\\index.ts", "mcp", "serve"],
    });
    // The rendered block must parse as JSON (backslashes escaped).
    expect(() => JSON.parse(snippet)).not.toThrow();
  });
});
