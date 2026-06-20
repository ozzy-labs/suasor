/**
 * OS scheduler snippet rendering for `suasor onboard` step 6 (ADR-0029 §5).
 *
 * Suasor runs no daemon — periodic `suasor sync` is delegated to the OS
 * scheduler (ADR-0027). The wizard surfaces a ready-to-paste template for the
 * host's scheduler. Rendering is a pure function with the OS **injected**, so
 * every OS branch is unit-testable without depending on the real `process.platform`.
 */

/** Supported scheduler kinds, keyed by the OS that uses them. */
export type SchedulerKind = "cron" | "launchd" | "systemd";

/** A rendered scheduler template plus the metadata `--json` reports. */
export interface SchedulerSnippet {
  /** Scheduler kind chosen for the OS. */
  readonly kind: SchedulerKind;
  /** Human label (e.g. `cron (crontab)`). */
  readonly label: string;
  /** The ready-to-paste snippet body. */
  readonly snippet: string;
}

/**
 * Map a Node `process.platform` value to the scheduler kind.
 * `darwin` → launchd; `win32` → cron (placeholder, no native timer rendered);
 * everything else (linux, *bsd) → systemd. cron is also a valid fallback on any
 * POSIX host, so callers may override.
 */
export function schedulerKindForPlatform(platform: NodeJS.Platform): SchedulerKind {
  if (platform === "darwin") return "launchd";
  if (platform === "win32") return "cron";
  return "systemd";
}

/** Render a cron crontab line. */
function renderCron(command: string): string {
  return [
    "# Hourly bulk sync (add with `crontab -e`); gate on the exit code.",
    `15 * * * * ${command} --json >> "$HOME/.local/state/suasor/sync.log" 2>&1`,
  ].join("\n");
}

/** Render a launchd plist (macOS). The command's argv is split on whitespace. */
function renderLaunchd(command: string): string {
  const argv = [...command.split(/\s+/).filter((s) => s.length > 0), "sync", "--json"];
  const args = argv.map((a) => `      <string>${a}</string>`).join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"',
    '  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "  <dict>",
    "    <key>Label</key>",
    "    <string>com.suasor.sync</string>",
    "    <key>ProgramArguments</key>",
    "    <array>",
    args,
    "    </array>",
    "    <key>StartInterval</key>",
    "    <integer>3600</integer>",
    "  </dict>",
    "</plist>",
  ].join("\n");
}

/** Render a systemd oneshot service + timer (Linux user units). */
function renderSystemd(command: string): string {
  return [
    "# ~/.config/systemd/user/suasor-sync.service",
    "[Unit]",
    "Description=Suasor bulk connector sync (one-shot)",
    "",
    "[Service]",
    "Type=oneshot",
    `ExecStart=${command} sync --json`,
    "",
    "# ~/.config/systemd/user/suasor-sync.timer",
    "[Unit]",
    "Description=Run Suasor sync hourly",
    "",
    "[Timer]",
    "OnCalendar=hourly",
    "Persistent=true",
    "",
    "[Install]",
    "WantedBy=timers.target",
  ].join("\n");
}

const LABELS: Record<SchedulerKind, string> = {
  cron: "cron (crontab)",
  launchd: "launchd (~/Library/LaunchAgents)",
  systemd: "systemd timer (~/.config/systemd/user)",
};

/**
 * Render the scheduler snippet for the given OS and `suasor` invocation command
 * (e.g. `suasor` or `/usr/local/bin/suasor`). The OS is injected for testability.
 *
 * @param platform - Node `process.platform`-style OS identifier.
 * @param command  - The `suasor` binary invocation (without the `sync` verb).
 * @param kind     - Optional explicit scheduler kind (overrides the OS default).
 */
export function renderSchedulerSnippet(
  platform: NodeJS.Platform,
  command: string,
  kind: SchedulerKind = schedulerKindForPlatform(platform),
): SchedulerSnippet {
  const snippet =
    kind === "launchd"
      ? renderLaunchd(command)
      : kind === "systemd"
        ? renderSystemd(command)
        : renderCron(command);
  return { kind, label: LABELS[kind], snippet };
}
