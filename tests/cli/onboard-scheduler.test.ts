/**
 * OS-injected scheduler snippet rendering (ADR-0029 §5). The OS is a parameter,
 * so every branch is testable without depending on the real process.platform.
 */
import { describe, expect, test } from "bun:test";
import { renderMcpSnippet } from "../../src/cli/onboard/mcp-snippet.ts";
import {
  renderDigestSchedulerLines,
  renderSchedulerSnippet,
  schedulerKindForPlatform,
  schedulerUnitTarget,
  splitSystemdUnits,
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

describe("renderDigestSchedulerLines — digest push jobs (ADR-0040)", () => {
  const jobs = [
    { name: "morning", schedule: "0 8 * * *" },
    { name: "slack-urgent" }, // no schedule → default cadence
  ];

  test("no configured job → null (standing consent: nothing to schedule)", () => {
    expect(renderDigestSchedulerLines("cron", "suasor", [])).toBeNull();
  });

  test("cron renders one paste-ready line per job, honouring job.schedule", () => {
    const out = renderDigestSchedulerLines("cron", "suasor", jobs);
    expect(out).toContain(
      '0 8 * * * suasor digest --job morning >> "$HOME/.local/state/suasor/digest.log" 2>&1',
    );
    expect(out).toContain("ADR-0040");
  });

  test("cron falls back to the default cadence when schedule is omitted", () => {
    const out = renderDigestSchedulerLines("cron", "suasor", [{ name: "slack-urgent" }]);
    expect(out).toContain("0 8 * * * suasor digest --job slack-urgent");
  });

  test("launchd renders per-job substitution guidance (no full plist)", () => {
    const out = renderDigestSchedulerLines("launchd", "/usr/local/bin/suasor", jobs);
    expect(out).toContain("com.suasor.digest-morning: /usr/local/bin/suasor digest --job morning");
    expect(out).toContain("com.suasor.digest-slack-urgent");
    expect(out).not.toContain("<plist");
  });

  test("systemd renders per-job ExecStart guidance", () => {
    const out = renderDigestSchedulerLines("systemd", "suasor", jobs);
    expect(out).toContain("suasor-digest-morning: ExecStart=suasor digest --job morning");
    expect(out).toContain("OnCalendar");
  });
  test("cron single-quotes a job name that is not shell-safe", () => {
    const out = renderDigestSchedulerLines("cron", "suasor", [{ name: "my job" }]);
    expect(out).toContain("digest --job 'my job' ");
    const quoted = renderDigestSchedulerLines("cron", "suasor", [{ name: "it's" }]);
    expect(quoted).toContain("digest --job 'it'\\''s' ");
  });
});

describe("scheduler unit targets (--write-launchd / --write-systemd, Issue #442)", () => {
  test("launchd names the LaunchAgents plist and the load command", () => {
    const target = schedulerUnitTarget("launchd");
    expect(target?.relativePath).toBe("Library/LaunchAgents/com.suasor.sync.plist");
    // Writing the file is not enough — launchd only runs a loaded agent, and a
    // written-but-never-loaded unit is exactly the silent no-sync this closes.
    expect(target?.activate).toContain("launchctl load");
  });

  test("systemd names the user unit dir and the enable command", () => {
    const target = schedulerUnitTarget("systemd");
    expect(target?.relativePath).toContain(".config/systemd/user/");
    expect(target?.activate).toContain("systemctl --user enable --now suasor-sync.timer");
  });

  test("cron has no unit file (it is written through the crontab command)", () => {
    expect(schedulerUnitTarget("cron")).toBeNull();
  });

  test("the systemd snippet splits into its two real files", () => {
    const snippet = renderSchedulerSnippet("linux", "suasor", "systemd").snippet;
    const files = splitSystemdUnits(snippet);
    expect(files.map((f) => f.relativePath)).toEqual([
      ".config/systemd/user/suasor-sync.service",
      ".config/systemd/user/suasor-sync.timer",
    ]);
    // The printed form is one document with `# ~/path` markers; systemd ignores
    // both units unless each half lands in its own file.
    expect(files[0]?.body).toContain("ExecStart=suasor sync --json");
    expect(files[0]?.body).not.toContain("[Timer]");
    expect(files[1]?.body).toContain("OnCalendar=hourly");
    expect(files[1]?.body).not.toContain("ExecStart");
  });
});
