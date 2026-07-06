/**
 * Digest delivery channels (ADR-0040 §3). Additive, each with its own discipline:
 *
 *  - `file`            — write the rendered digest under the `[export].dir` sandbox
 *                        (ADR-0025: basename only, never inside a local connector
 *                        root). No egress.
 *  - `os-notification` — hand a compact form to the OS notifier (osascript /
 *                        notify-send / PowerShell). No egress.
 *  - `slack-dm`        — DM-to-self via the Slack Web API (ADR-0036 actuator path):
 *                        `conversations.open` → `chat.postMessage`. Token comes
 *                        from the OS keychain, is never echoed, and every failure
 *                        surfaces as a structured {@link DigestChannelError}.
 *
 * The delivery functions take a *resolved* target (secrets / paths already looked
 * up by the caller) plus injectable side-effect deps, so every path is unit-
 * testable without a keychain, a real notifier, or the network.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { DigestChannelName } from "../config/schema.ts";
import { slackFetch as defaultSlackFetch } from "../connectors/slack/_fetch.ts";
import type { DigestNotification } from "./content.ts";

/** The channel-ready payload: full text (file / Slack) + compact form (OS). */
export interface DigestPayload {
  /** Full rendered digest text. */
  text: string;
  /** Compact title + one-line body for OS notifiers. */
  notification: DigestNotification;
}

/** Where a delivery landed (a file path, the notifier, or a Slack channel id). */
export interface DigestDelivery {
  channel: DigestChannelName;
  status: "delivered";
  detail: string;
}

/**
 * A delivery failure carrying a stable, machine-matchable `code` (ADR-0036
 * structured-error discipline). Secrets are never included in the message.
 */
export class DigestChannelError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DigestChannelError";
    this.code = code;
  }
}

// --- file channel (ADR-0025 sandbox) -----------------------------------------

/** Resolved `file` target: the export sandbox dir + a validated basename. */
export interface FileChannelTarget {
  kind: "file";
  /** Absolute export sandbox dir (`config.export.dir`). */
  dir: string;
  /** Output basename (no path separators / traversal / abs). */
  filename: string;
  /** `[connectors.local].roots` — the export dir must not nest under any. */
  localRoots?: string[];
}

/** Injectable filesystem ops (defaults to `node:fs`); overridden in tests. */
export interface FileChannelDeps {
  writeFile?: (path: string, content: string) => void;
  mkdir?: (path: string) => void;
}

/** True when `dir` equals or is nested under `root` (both resolved absolute). */
function isInside(dir: string, root: string): boolean {
  const d = resolve(dir);
  const r = resolve(root);
  return d === r || d.startsWith(r + sep);
}

/**
 * Write the digest text into the export sandbox (ADR-0025). Overwrites the same
 * file each run (the digest is regenerated, unlike a user draft), so the latest
 * digest is always at a stable path. Throws {@link DigestChannelError} on a bad
 * filename or a sandbox that overlaps a local connector root (re-ingest loop).
 */
export function deliverToFile(
  target: FileChannelTarget,
  payload: DigestPayload,
  deps: FileChannelDeps = {},
): DigestDelivery {
  const { filename } = target;
  if (
    filename.length === 0 ||
    filename === "." ||
    filename === ".." ||
    filename.includes("/") ||
    filename.includes("\\") ||
    isAbsolute(filename)
  ) {
    throw new DigestChannelError(
      "INVALID_FILENAME",
      `invalid filename (basename only): ${filename}`,
    );
  }
  for (const root of target.localRoots ?? []) {
    if (isInside(target.dir, root)) {
      throw new DigestChannelError(
        "EXPORT_DIR_IN_LOCAL_ROOT",
        `export dir ${target.dir} is inside local connector root ${root} (would re-ingest)`,
      );
    }
  }
  const mkdir = deps.mkdir ?? ((p: string) => mkdirSync(p, { recursive: true }));
  const writeFile = deps.writeFile ?? ((p: string, c: string) => writeFileSync(p, c));
  mkdir(target.dir);
  const path = join(target.dir, filename);
  writeFile(path, payload.text);
  return { channel: "file", status: "delivered", detail: path };
}

// --- os-notification channel -------------------------------------------------

/** Resolved `os-notification` target (platform is resolved by the caller / here). */
export interface OsNotificationTarget {
  kind: "os-notification";
}

export interface OsNotificationDeps {
  /** `process.platform` override for command selection (tests inject one). */
  platform?: NodeJS.Platform;
  /** Spawn override returning the child exit code (tests inject a fake). */
  spawn?: (command: string, args: string[]) => Promise<number>;
}

/**
 * Build the argv for the platform's notifier, or `null` when unsupported. Pure —
 * no shell is involved (args are passed literally), so notification text needs no
 * shell-escaping; osascript's AppleScript string literal is the only quoted form.
 */
export function osNotificationCommand(
  platform: NodeJS.Platform,
  notification: DigestNotification,
): { command: string; args: string[] } | null {
  const { title, body } = notification;
  switch (platform) {
    case "darwin": {
      const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return {
        command: "osascript",
        args: ["-e", `display notification "${esc(body)}" with title "${esc(title)}"`],
      };
    }
    case "linux":
      return { command: "notify-send", args: [title, body] };
    case "win32": {
      // Balloon tip via WinForms NotifyIcon — available on a stock PowerShell.
      const esc = (s: string) => s.replace(/'/g, "''");
      const script = [
        "Add-Type -AssemblyName System.Windows.Forms;",
        "$n = New-Object System.Windows.Forms.NotifyIcon;",
        "$n.Icon = [System.Drawing.SystemIcons]::Information;",
        "$n.Visible = $true;",
        `$n.ShowBalloonTip(10000, '${esc(title)}', '${esc(body)}', [System.Windows.Forms.ToolTipIcon]::Info);`,
      ].join(" ");
      return { command: "powershell", args: ["-NoProfile", "-Command", script] };
    }
    default:
      return null;
  }
}

const defaultSpawn = (command: string, args: string[]): Promise<number> =>
  new Promise((resolvePromise, reject) => {
    // Lazy require so the module stays import-light for non-notification paths.
    import("node:child_process")
      .then(({ spawn }) => {
        const child = spawn(command, args, { stdio: "ignore" });
        child.on("error", reject);
        child.on("close", (code) => resolvePromise(code ?? 0));
      })
      .catch(reject);
  });

/**
 * Hand the compact digest form to the OS notifier. Throws
 * {@link DigestChannelError} when the platform has no supported notifier, the
 * notifier binary is missing, or it exits non-zero.
 */
export async function deliverToOsNotification(
  _target: OsNotificationTarget,
  payload: DigestPayload,
  deps: OsNotificationDeps = {},
): Promise<DigestDelivery> {
  const platform = deps.platform ?? process.platform;
  const built = osNotificationCommand(platform, payload.notification);
  if (built === null) {
    throw new DigestChannelError(
      "OS_NOTIFICATION_UNSUPPORTED",
      `no OS notifier is wired for platform '${platform}'`,
    );
  }
  const spawn = deps.spawn ?? defaultSpawn;
  let code: number;
  try {
    code = await spawn(built.command, built.args);
  } catch (err) {
    throw new DigestChannelError(
      "OS_NOTIFICATION_FAILED",
      `notifier '${built.command}' could not run: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (code !== 0) {
    throw new DigestChannelError(
      "OS_NOTIFICATION_FAILED",
      `notifier '${built.command}' exited with code ${code}`,
    );
  }
  return { channel: "os-notification", status: "delivered", detail: built.command };
}

// --- slack-dm channel (ADR-0036 actuator egress) -----------------------------

/** Resolved `slack-dm` target: DM-to-self via a workspace token + self user id. */
export interface SlackDmTarget {
  kind: "slack-dm";
  /** Bearer token (from the OS keychain); never echoed in errors. */
  token: string;
  /** Operator's own Slack user id, the DM counterpart (ADR-0012). */
  selfUserId: string;
  /** API base (default `https://slack.com/api`); overridden in tests. */
  apiBase?: string;
}

export interface SlackDmDeps {
  /** `fetch` override passed through to `slackFetch` (tests inject a fake). */
  fetchImpl?: typeof fetch;
  /** `slackFetch` override (defaults to the shared rate-limit-aware transport). */
  slackFetch?: typeof defaultSlackFetch;
}

/** Slack rejects very long messages; cap the DM text to stay well under limits. */
const SLACK_TEXT_CAP = 3500;

/**
 * DM the digest to the operator themselves (ADR-0036 §actuator egress): open the
 * self-DM (`conversations.open`) then `chat.postMessage`. Both calls carry args
 * as query params with the token in the `Authorization` header (matching the
 * other `slackFetch` callers). Missing token / self id and Slack `ok:false` all
 * surface as a structured {@link DigestChannelError}; the token is never logged.
 */
export async function deliverToSlackDm(
  target: SlackDmTarget,
  payload: DigestPayload,
  deps: SlackDmDeps = {},
): Promise<DigestDelivery> {
  if (target.token.length === 0) {
    throw new DigestChannelError(
      "SLACK_TOKEN_NOT_CONFIGURED",
      "no Slack token in the keychain (run `suasor slack auth set`)",
    );
  }
  if (target.selfUserId.length === 0) {
    throw new DigestChannelError(
      "SLACK_SELF_ID_NOT_CONFIGURED",
      "no Slack self_user_id configured ([connectors.slack].self_user_id)",
    );
  }
  const base = target.apiBase ?? "https://slack.com/api";
  const call = deps.slackFetch ?? defaultSlackFetch;
  const fetchOpt = deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {};

  // 1) Resolve (open) the DM channel with oneself.
  const open = await call(
    `${base}/conversations.open?users=${encodeURIComponent(target.selfUserId)}`,
    { token: target.token, method: "POST", ...fetchOpt },
  );
  if (open.body.ok !== true) {
    throw new DigestChannelError(
      "SLACK_API_ERROR",
      `conversations.open failed: ${String(open.body.error ?? "unknown")}`,
    );
  }
  const channel = (open.body.channel as { id?: string } | undefined)?.id;
  if (channel === undefined || channel.length === 0) {
    throw new DigestChannelError("SLACK_API_ERROR", "conversations.open returned no channel id");
  }

  // 2) Post the digest text to that DM channel.
  const text =
    payload.text.length > SLACK_TEXT_CAP
      ? `${payload.text.slice(0, SLACK_TEXT_CAP)}…`
      : payload.text;
  const post = await call(
    `${base}/chat.postMessage?channel=${encodeURIComponent(channel)}&text=${encodeURIComponent(text)}`,
    { token: target.token, method: "POST", ...fetchOpt },
  );
  if (post.body.ok !== true) {
    throw new DigestChannelError(
      "SLACK_API_ERROR",
      `chat.postMessage failed: ${String(post.body.error ?? "unknown")}`,
    );
  }
  return { channel: "slack-dm", status: "delivered", detail: `dm:${channel}` };
}

// --- dispatch ----------------------------------------------------------------

/** A resolved delivery target for any channel. */
export type DigestTarget = FileChannelTarget | OsNotificationTarget | SlackDmTarget;

/** Combined injectable deps for {@link deliverDigest}. */
export interface DigestDeliveryDeps {
  file?: FileChannelDeps;
  osNotification?: OsNotificationDeps;
  slackDm?: SlackDmDeps;
}

/**
 * Dispatch a rendered digest to its resolved channel target. Throws
 * {@link DigestChannelError} on any delivery failure (the caller decides whether
 * to fail the whole run or continue to the next job).
 */
export function deliverDigest(
  target: DigestTarget,
  payload: DigestPayload,
  deps: DigestDeliveryDeps = {},
): Promise<DigestDelivery> {
  switch (target.kind) {
    case "file":
      return Promise.resolve(deliverToFile(target, payload, deps.file));
    case "os-notification":
      return deliverToOsNotification(target, payload, deps.osNotification);
    case "slack-dm":
      return deliverToSlackDm(target, payload, deps.slackDm);
  }
}
