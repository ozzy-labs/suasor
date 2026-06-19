/**
 * Slack connector (ADR-0007). Read-only ingest of channel messages for the
 * configured channels into `SourceRecord`s.
 *
 * - **read-only** — only `conversations.history` (a read endpoint) is called;
 *   nothing is posted back to Slack (ADR-0003).
 * - **delta** — Slack's `conversations.history` is a delta API: it accepts an
 *   `oldest` timestamp. The connector records the most recent message `ts` seen
 *   **per channel** and returns a JSON `{ <channel>: <ts> }` map as the next
 *   cursor so each channel resumes from its own high-water mark (FR-ING-3). A
 *   single shared cursor was a latent data-loss bug: a quiet channel would be
 *   raised to a busier channel's `ts` and silently skip its own newer messages
 *   (ADR-0011). A bare-`ts` cursor from before this change is read as a legacy
 *   floor applied to every channel on the first run after upgrade.
 * - **identity** — `slack:<team>:<channel>:<ts>` (cross-source-unique,
 *   team+channel-prefixed, ADR-0007). `source_type` is `slack_message`.
 * - **import-clean** — `@slack/web-api` is **lazy-imported inside `sync`**, so
 *   building the connector / registry never pulls the SDK (ADR-0007, NFR-PRF-1).
 *   This module's top-level imports are limited to `zod` + the contract types.
 * - **secrets** — the bot token comes from `ctx.secret("token")` (keychain + env
 *   override, NFR-PRV-4); it is never read from config.
 */
import { z } from "zod";
import type {
  Connector,
  ConnectorConfig,
  SourceRecord,
  SyncContext,
  SyncResult,
} from "./contract.ts";

/** One workspace's ingest target (a single Slack team). */
export const SlackWorkspaceConfig = z.object({
  /** Team / workspace id used to prefix ids (kept stable across renames). */
  team: z.string().min(1).default("default"),
  /** Channel ids to ingest (e.g. "C0123ABCD"). */
  channels: z.array(z.string().min(1)).default([]),
});
export type SlackWorkspaceConfig = z.infer<typeof SlackWorkspaceConfig>;

/**
 * `[connectors.slack]` config (docs/design/config.md, ADR-0014).
 *
 * Two shapes, mutually exclusive:
 * - **flat** (`team` + `channels`) — a single workspace, the `default` alias.
 *   Backward compatible with the pre-multi-workspace config.
 * - **multi** (`[connectors.slack.workspaces.<alias>]`) — N workspaces, each
 *   with its own team/channels and its own token (`connector:slack:<alias>:token`).
 * When `workspaces` is present and non-empty it wins; otherwise the flat fields
 * synthesize the single `default` workspace.
 */
export const SlackConnectorConfig = z.object({
  team: z.string().min(1).default("default"),
  channels: z.array(z.string().min(1)).default([]),
  workspaces: z.record(z.string(), SlackWorkspaceConfig).optional(),
});
export type SlackConnectorConfig = z.infer<typeof SlackConnectorConfig>;

export const SLACK_CONNECTOR_NAME = "slack";

/** Alias of the flat (single-workspace) config shape. */
export const DEFAULT_WORKSPACE_ALIAS = "default";

/**
 * The keychain secret name (passed to `ctx.secret`) for a workspace alias:
 * `"token"` for the flat/default workspace (backward compatible with the
 * single-token account `connector:slack:token`), or `"<alias>:token"` for a
 * named workspace (`connector:slack:<alias>:token`). Shared by the connector and
 * the `slack auth` CLI so both resolve the same account (ADR-0014).
 */
export function workspaceSecretName(alias?: string): string {
  return alias ? `${alias}:token` : "token";
}

/** A workspace resolved for a sync pass: where to read + which secret to use. */
interface ResolvedWorkspace {
  alias: string;
  team: string;
  channels: string[];
  secretName: string;
}

/** Expand the config into the concrete list of workspaces to sync. */
function resolveWorkspaces(config: SlackConnectorConfig): ResolvedWorkspace[] {
  const ws = config.workspaces;
  if (ws && Object.keys(ws).length > 0) {
    return Object.entries(ws).map(([alias, w]) => ({
      alias,
      team: w.team,
      channels: w.channels,
      secretName: workspaceSecretName(alias),
    }));
  }
  return [
    {
      alias: DEFAULT_WORKSPACE_ALIAS,
      team: config.team,
      channels: config.channels,
      secretName: workspaceSecretName(),
    },
  ];
}

/** Shape of the message items we read (subset of the Slack response). */
interface SlackMessageItem {
  ts: string;
  text?: string;
  user?: string;
  thread_ts?: string;
}

/** Build the `SourceRecord` for one message of a channel. */
function toRecord(team: string, channel: string, item: SlackMessageItem): SourceRecord {
  return {
    externalId: `slack:${team}:${channel}:${item.ts}`,
    sourceType: "slack_message",
    body: item.text ?? "",
    // Slack `ts` is `<unix-seconds>.<microseconds>`; expose it as ISO 8601.
    observedAt: new Date(Math.floor(Number.parseFloat(item.ts) * 1000)).toISOString(),
    meta: {
      team,
      channel,
      ts: item.ts,
      user: item.user ?? null,
      ...(item.thread_ts ? { threadTs: item.thread_ts } : {}),
    },
  };
}

/**
 * The Slack `WebClient` surface we depend on. Declared structurally so tests can
 * inject a fake without importing the SDK, and so the real client is lazy-loaded.
 */
export interface SlackClientLike {
  conversations: {
    history: (args: {
      channel: string;
      oldest?: string;
      limit?: number;
      cursor?: string;
    }) => Promise<{
      messages?: SlackMessageItem[];
      response_metadata?: { next_cursor?: string };
    }>;
  };
}

/** How the connector obtains a Slack client (overridable in tests). */
export type SlackClientFactory = (token: string) => Promise<SlackClientLike> | SlackClientLike;

/** Default factory: lazy-imports `@slack/web-api` so registration stays import-clean. */
const defaultSlackClientFactory: SlackClientFactory = async (token) => {
  const { WebClient } = await import("@slack/web-api");
  return new WebClient(token) as unknown as SlackClientLike;
};

export interface SlackConnectorOptions {
  /** Slack client factory override (tests inject a fake; default lazy-imports the SDK). */
  clientFactory?: SlackClientFactory;
}

/**
 * Parse the resume cursor into a per-alias → per-channel high-water-mark map
 * (ADR-0014). Three input shapes are accepted for backward compatibility:
 * - **nested** `{ "<alias>": { "<channel>": "<ts>" } }` — the current format.
 * - **flat** `{ "<channel>": "<ts>" }` — the pre-multi-workspace format
 *   (ADR-0011); read as the `default` alias.
 * - **bare ts** — the pre-per-channel legacy cursor (ADR-0011); returned as a
 *   `legacyFloor` applied to the `default` workspace's channels on first run.
 */
function parseCursor(raw: string | null): {
  byAlias: Record<string, Record<string, string>>;
  legacyFloor: string | null;
} {
  if (!raw) return { byAlias: {}, legacyFloor: null };
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return { byAlias: {}, legacyFloor: trimmed };
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const byAlias: Record<string, Record<string, string>> = {};
    const flat: Record<string, string> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === "string") {
        flat[key] = value; // flat (legacy single-workspace) entry
      } else if (value && typeof value === "object") {
        const inner: Record<string, string> = {};
        for (const [ch, ts] of Object.entries(value)) if (typeof ts === "string") inner[ch] = ts;
        byAlias[key] = inner;
      }
    }
    if (Object.keys(flat).length > 0) {
      byAlias[DEFAULT_WORKSPACE_ALIAS] = { ...flat, ...byAlias[DEFAULT_WORKSPACE_ALIAS] };
    }
    return { byAlias, legacyFloor: null };
  } catch {
    // Unparseable cursor → treat as a fresh start rather than crash.
    return { byAlias: {}, legacyFloor: null };
  }
}

/** Slack connector implementing the read-only contract (ADR-0007 / ADR-0014). */
class SlackConnector implements Connector {
  readonly name = SLACK_CONNECTOR_NAME;
  readonly sourceType = "slack";

  /** Per-alias → per-channel highest `ts` observed this run → next-run cursor. */
  private cursors: Record<string, Record<string, string>> = {};

  constructor(
    private readonly config: SlackConnectorConfig,
    private readonly clientFactory: SlackClientFactory,
  ) {}

  async *sync(ctx: SyncContext): AsyncIterable<SourceRecord> {
    const workspaces = resolveWorkspaces(this.config).filter((w) => w.channels.length > 0);
    if (workspaces.length === 0) return;

    const { byAlias: previous, legacyFloor } = parseCursor(ctx.cursor);
    // Start empty and seed only configured aliases/channels below, so cursors
    // for workspaces/channels removed from config don't accumulate forever.
    this.cursors = {};
    let anyTokenResolved = false;

    for (const ws of workspaces) {
      const token = await ctx.secret(ws.secretName);
      if (!token) {
        // Per-workspace isolation (ADR-0014): skip this workspace, keep the rest
        // syncing, and preserve its prior cursor so the skip isn't a reset.
        const hint =
          ws.alias === DEFAULT_WORKSPACE_ALIAS
            ? "`suasor slack auth set`"
            : `\`suasor slack auth set --workspace ${ws.alias}\``;
        ctx.onWarn?.(`workspace '${ws.alias}' skipped: no token (run ${hint})`);
        if (previous[ws.alias]) this.cursors[ws.alias] = { ...previous[ws.alias] };
        continue;
      }
      anyTokenResolved = true;

      const client = await this.clientFactory(token);
      const prevChannels = previous[ws.alias] ?? {};
      const aliasCursors: Record<string, string> = {};

      for (const channel of ws.channels) {
        // Each channel resumes from its OWN high-water mark (or, only for the
        // default workspace, the legacy floor) — never another channel's.
        const oldest =
          prevChannels[channel] ??
          (ws.alias === DEFAULT_WORKSPACE_ALIAS ? (legacyFloor ?? undefined) : undefined);
        let cursor: string | undefined;
        do {
          const page = await client.conversations.history({
            channel,
            limit: 200,
            ...(oldest ? { oldest } : {}),
            ...(cursor ? { cursor } : {}),
          });
          for (const item of page.messages ?? []) {
            const seen = aliasCursors[channel];
            if (seen === undefined || Number.parseFloat(item.ts) > Number.parseFloat(seen)) {
              aliasCursors[channel] = item.ts;
            }
            yield toRecord(ws.team, channel, item);
          }
          cursor = page.response_metadata?.next_cursor || undefined;
        } while (cursor);

        // Preserve the floor for a channel with no new messages so it is not
        // re-scanned from scratch on the next run.
        if (aliasCursors[channel] === undefined && oldest !== undefined) {
          aliasCursors[channel] = oldest;
        }
      }
      this.cursors[ws.alias] = aliasCursors;
    }

    if (!anyTokenResolved) {
      throw new Error(
        "slack connector: no token configured for any workspace " +
          "(set SUASOR_CONNECTOR_SLACK_TOKEN or run `suasor slack auth set`)",
      );
    }
  }

  finalize(): SyncResult {
    const out: Record<string, Record<string, string>> = {};
    for (const [alias, map] of Object.entries(this.cursors)) {
      if (Object.keys(map).length > 0) out[alias] = map;
    }
    return { cursor: Object.keys(out).length > 0 ? JSON.stringify(out) : null };
  }
}

/**
 * Build the Slack connector from its config slice (validates with Zod).
 * `@slack/web-api` is not imported here — only when `sync` actually runs.
 */
export function createSlackConnector(
  config: ConnectorConfig,
  options: SlackConnectorOptions = {},
): Connector {
  const parsed = SlackConnectorConfig.parse(config ?? {});
  return new SlackConnector(parsed, options.clientFactory ?? defaultSlackClientFactory);
}
