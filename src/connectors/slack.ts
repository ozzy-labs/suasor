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
import { ConfigError } from "../config/error.ts";
import type {
  Connector,
  ConnectorConfig,
  SourceRecord,
  SyncContext,
  SyncResult,
} from "./contract.ts";
import { type ResolvedChannel, resolveChannel } from "./slack/channel.ts";
import {
  defaultUsersTransport,
  resolveUserName,
  type SlackUsersTransport,
} from "./slack/resolve.ts";

/** One workspace's ingest target (a single Slack team). */
export const SlackWorkspaceConfig = z.object({
  /** Team / workspace id used to prefix ids (kept stable across renames). */
  team: z.string().min(1).default("default"),
  /** Channel ids to ingest (e.g. "C0123ABCD"). */
  channels: z.array(z.string().min(1)).default([]),
  /**
   * Cold-start date floor (ADR-0016): messages older than this are never
   * fetched, capping the first sync. Relative (`30d` / `4w` / `12h`) or an ISO
   * date (`2026-01-01`). Applies only to channels with no saved cursor — a
   * channel already past the floor keeps resuming from its cursor.
   */
  since: z.string().min(1).optional(),
  /**
   * Per-channel `since` override (ADR-0016 / #57): a map of channel id → floor
   * (`30d` / `2026-01-01`) that takes precedence over the workspace-level
   * `since` for those channels. Channels not listed fall back to `since`.
   */
  channel_since: z.record(z.string(), z.string().min(1)).optional(),
  /**
   * The operator's own Slack user id (`Uxxxx`) for this workspace, used by
   * `slack.demand.list` to detect `<@you>` mentions (ADR-0012). Resolve it from
   * `slack auth test` (the `userId` field). Optional: without it, demand falls
   * back to DM-only.
   */
  self_user_id: z.string().min(1).optional(),
  /** Slack List ids to mirror for task read-back in this workspace (ADR-0036 §6). */
  lists: z.array(z.string().min(1)).optional(),
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
  /** Cold-start date floor for the flat/default workspace (ADR-0016). */
  since: z.string().min(1).optional(),
  /** Per-channel `since` override for the flat/default workspace (ADR-0016 / #57). */
  channel_since: z.record(z.string(), z.string().min(1)).optional(),
  /** Operator's own user id for the flat/default workspace (ADR-0012). */
  self_user_id: z.string().min(1).optional(),
  /**
   * Slack List ids to mirror as `slack_list_item` sources for task read-back
   * (ADR-0036 §6). The items are ingested with **raw cells** (no interpretation);
   * `reconcileReadback` maps them to a task state using `[tasks.home]` column ids.
   * Uses the flat/default token (`lists:read`). Multi-workspace lists are a
   * follow-up.
   */
  lists: z.array(z.string().min(1)).optional(),
  workspaces: z.record(z.string(), SlackWorkspaceConfig).optional(),
});
export type SlackConnectorConfig = z.infer<typeof SlackConnectorConfig>;

/**
 * Collect the operator's Slack user ids from the connector config slice across
 * the flat/default workspace and every `workspaces.<alias>` (ADR-0012). Used by
 * the `slack.demand.list` MCP tool to detect `<@you>` mentions. Returns a
 * de-duplicated list (empty when none configured → DM-only demand).
 */
export function resolveSelfUserIds(config: ConnectorConfig): string[] {
  const parsed = SlackConnectorConfig.parse(config ?? {});
  const ids = new Set<string>();
  if (parsed.self_user_id) ids.add(parsed.self_user_id);
  for (const ws of Object.values(parsed.workspaces ?? {})) {
    if (ws.self_user_id) ids.add(ws.self_user_id);
  }
  return [...ids];
}

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
export interface ResolvedWorkspace {
  alias: string;
  team: string;
  channels: string[];
  /** Slack List ids to mirror for read-back in this workspace (ADR-0036 §6). */
  lists: string[];
  secretName: string;
  since?: string;
  channelSince?: Record<string, string>;
  /** Operator's own user id, excluded from group-DM name joins (ADR-0037 §4). */
  selfUserId?: string;
}

/** Expand the config into the concrete list of workspaces to sync. */
export function resolveWorkspaces(config: SlackConnectorConfig): ResolvedWorkspace[] {
  const ws = config.workspaces;
  if (ws && Object.keys(ws).length > 0) {
    return Object.entries(ws).map(([alias, w]) => ({
      alias,
      team: w.team,
      channels: w.channels,
      lists: w.lists ?? [],
      secretName: workspaceSecretName(alias),
      ...(w.since ? { since: w.since } : {}),
      ...(w.channel_since ? { channelSince: w.channel_since } : {}),
      ...(w.self_user_id ? { selfUserId: w.self_user_id } : {}),
    }));
  }
  return [
    {
      alias: DEFAULT_WORKSPACE_ALIAS,
      team: config.team,
      channels: config.channels,
      lists: config.lists ?? [],
      secretName: workspaceSecretName(),
      ...(config.since ? { since: config.since } : {}),
      ...(config.channel_since ? { channelSince: config.channel_since } : {}),
      ...(config.self_user_id ? { selfUserId: config.self_user_id } : {}),
    },
  ];
}

/** `<n><unit>` relative-duration syntax for {@link parseSinceToTs} (d/w/h). */
const RELATIVE_SINCE = /^(\d+)([dwh])$/;
const UNIT_SECONDS: Record<string, number> = { h: 3600, d: 86400, w: 604800 };

/**
 * Convert a `since` floor (ADR-0016) to a Slack `oldest` ts (`<seconds>.000000`),
 * or `null` when it cannot be parsed. Accepts a relative `30d` / `4w` / `12h`
 * (relative to `nowMs`) or an ISO date / datetime (`2026-01-01`). Exported for
 * direct unit testing of the conversion.
 */
export function parseSinceToTs(since: string, nowMs: number): string | null {
  const rel = RELATIVE_SINCE.exec(since.trim());
  if (rel) {
    const amount = Number(rel[1]);
    const unit = UNIT_SECONDS[rel[2] as string] as number;
    const seconds = Math.floor(nowMs / 1000) - amount * unit;
    return `${Math.max(0, seconds)}.000000`;
  }
  const parsed = Date.parse(since.trim());
  if (Number.isNaN(parsed)) return null;
  return `${Math.floor(parsed / 1000)}.000000`;
}

/**
 * Whether a `since` floor (ADR-0016) is parseable — a relative `30d` / `4w` /
 * `12h` or an ISO date / datetime. Time-independent: parseability does not
 * depend on the current clock, so a fixed `0` epoch is passed to
 * {@link parseSinceToTs}. Used by config-load validation to fail fast on values
 * that would otherwise silently degrade to "no floor" (ADR-0007).
 */
export function isSinceParseable(since: string): boolean {
  return parseSinceToTs(since, 0) !== null;
}

/**
 * Validate every `since` / `channel_since` value in a parsed Slack config so an
 * unparseable floor fails fast at config-load time instead of silently becoming
 * "no floor" mid-sync (ADR-0007 "no silent wrong answer", Issue #157). Collects
 * all offending entries and throws a single {@link ConfigError}; a valid config
 * returns without throwing.
 */
export function validateSlackSince(config: SlackConnectorConfig): void {
  const issues: string[] = [];

  const checkSince = (value: string | undefined, label: string): void => {
    if (value !== undefined && !isSinceParseable(value)) {
      issues.push(
        `${label}: invalid since '${value}' (expected relative '30d'/'4w'/'12h' or ISO date '2026-01-01')`,
      );
    }
  };
  const checkChannelSince = (map: Record<string, string> | undefined, label: string): void => {
    for (const [channel, value] of Object.entries(map ?? {})) {
      checkSince(value, `${label}.${channel}`);
    }
  };

  // Flat / default workspace.
  checkSince(config.since, "connectors.slack.since");
  checkChannelSince(config.channel_since, "connectors.slack.channel_since");
  // Named workspaces.
  for (const [alias, ws] of Object.entries(config.workspaces ?? {})) {
    checkSince(ws.since, `connectors.slack.workspaces.${alias}.since`);
    checkChannelSince(ws.channel_since, `connectors.slack.workspaces.${alias}.channel_since`);
  }

  if (issues.length > 0) {
    throw new ConfigError("invalid Slack connector configuration", issues);
  }
}

/** The more recent (numerically larger) of two optional ts floors. */
function higherTs(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Number.parseFloat(a) >= Number.parseFloat(b) ? a : b;
}

/**
 * Slack error codes that mean a *single channel* is unreachable — the bot has
 * not joined it / was never `/invite`'d, or the id is stale / archived — as
 * opposed to a workspace-wide failure (`ratelimited`, auth, network). Readiness
 * (`auth test`) is a scope verdict only; membership is a separate layer
 * (ADR-0011), so these are surfaced per channel as an aggregated warn rather than
 * aborting the whole workspace and silently dropping the reachable channels.
 */
const UNREACHABLE_CHANNEL_ERRORS = new Set(["not_in_channel", "channel_not_found", "is_archived"]);

/**
 * Extract the Slack `error` code from a thrown error, or `null`. `@slack/web-api`
 * raises a `SlackAPIError` carrying `data.error` (the `ok:false` code); fakes /
 * raw-fetch transports may instead surface the code in the message. Only codes in
 * {@link UNREACHABLE_CHANNEL_ERRORS} are recovered from the message (so an
 * unrelated message that merely contains the word is not misclassified).
 */
function unreachableChannelCode(error: unknown): string | null {
  const data = (error as { data?: { error?: unknown } } | null)?.data;
  if (data && typeof data.error === "string" && UNREACHABLE_CHANNEL_ERRORS.has(data.error)) {
    return data.error;
  }
  const message = error instanceof Error ? error.message : String(error);
  for (const code of UNREACHABLE_CHANNEL_ERRORS) {
    if (message.includes(code)) return code;
  }
  return null;
}

/**
 * Slack conversation ids start with `C` (public channel), `G` (private channel
 * / group-DM), or `D` (DM). A configured `channels` value that does not — most
 * commonly a channel **name** like `#general` — is almost certainly a
 * misconfiguration: `conversations.history` keys off the id, so a name silently
 * ingests zero messages (ADR-0007 "no silent wrong answer", Issue #158).
 *
 * We warn rather than fail: Slack's id prefixes are not contractually frozen,
 * so a hard reject could lock out a future-valid id. `slack conversations`
 * surfaces the right ids to copy.
 */
const SLACK_CHANNEL_ID_PREFIX = /^[CDG]/;

/** Whether a configured `channels` value looks like a Slack conversation id. */
export function looksLikeSlackChannelId(channel: string): boolean {
  return SLACK_CHANNEL_ID_PREFIX.test(channel.trim());
}

/** Shape of the message items we read (subset of the Slack response). */
interface SlackMessageItem {
  ts: string;
  text?: string;
  user?: string;
  thread_ts?: string;
  /** Reply count on a thread parent; `>0` triggers a `conversations.replies` fetch (ADR-0015). */
  reply_count?: number;
}

/**
 * Build the `SourceRecord` for one message of a channel. `userName` is the
 * sync-time-resolved author display name (ADR-0037 §2): stored under
 * `meta.userName` when present so `authorFromMeta` can enrich the person
 * projection. A `null` / empty resolution leaves `meta.userName` unset — the
 * degrade path (ADR-0037 §6) where the person keeps its id-derived name.
 *
 * `channelInfo` is the sync-time-resolved channel name / kind (ADR-0037 §3):
 * `meta.channelKind` is always set (from the id prefix even on degrade) and
 * `meta.channelName` only when a non-empty name was resolved, so `channelFromMeta`
 * can fold a `SlackChannelObserved` (an empty name degrades to an id fallback).
 */
function toRecord(
  team: string,
  channel: string,
  item: SlackMessageItem,
  userName?: string | null,
  channelInfo?: ResolvedChannel,
): SourceRecord {
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
      ...(userName ? { userName } : {}),
      ...(channelInfo
        ? {
            channelKind: channelInfo.kind,
            ...(channelInfo.name ? { channelName: channelInfo.name } : {}),
          }
        : {}),
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
    /** Thread replies for a parent message (`ts`), paginated like `history` (ADR-0015). */
    replies: (args: {
      channel: string;
      ts: string;
      oldest?: string;
      limit?: number;
      cursor?: string;
    }) => Promise<{
      messages?: SlackMessageItem[];
      response_metadata?: { next_cursor?: string };
    }>;
    /**
     * Channel metadata for name resolution (ADR-0037 §3). Optional so existing
     * message-only fakes need not implement it — channel-name resolution then
     * degrades to id-only (no live fetch) rather than reaching the network.
     */
    info?: (args: { channel: string }) => Promise<{
      ok?: boolean;
      channel?: {
        name?: string;
        is_private?: boolean;
        is_im?: boolean;
        is_mpim?: boolean;
        user?: string;
      };
    }>;
    /** Member ids of a (group) conversation, for group-DM name join (ADR-0037 §4). */
    members?: (args: { channel: string }) => Promise<{ ok?: boolean; members?: string[] }>;
  };
  /**
   * List items for a Slack List (ADR-0036 §6 read-back). Optional so existing
   * message-only fakes need not implement it; List ingest is skipped when absent.
   */
  slackListsItems?: (args: { list_id: string; cursor?: string; limit?: number }) => Promise<{
    items?: SlackListItem[];
    response_metadata?: { next_cursor?: string };
  }>;
}

/** A Slack List item (record) and its raw cells, as `slackLists.items.list` returns. */
export interface SlackListItem {
  id?: string;
  fields?: Array<{
    /** Stable column key (always present in `items.list` responses). */
    key?: string;
    /** Encoded column id (optional in responses; the id used by create/update). */
    column_id?: string;
    checkbox?: boolean;
    select?: string[];
    text?: string;
  }>;
}

/**
 * Build a `slack_list_item` SourceRecord from a raw List item (ADR-0036 §6). The
 * cells are stored verbatim in `meta.cells`; `reconcileReadback` interprets them
 * with the `[tasks.home]` column config. The fingerprint hashes the cells so a
 * checkbox/status change re-ingests (the title body alone wouldn't change).
 * externalId mirrors the actuator's published id exactly (the read-back join key).
 */
export function listItemToRecord(
  listId: string,
  item: SlackListItem,
  observedAt: string,
): SourceRecord {
  const fields = item.fields ?? [];
  const title = fields.find((f) => typeof f.text === "string" && f.text)?.text ?? item.id ?? "";
  return {
    externalId: `slack:list:${listId}:item:${item.id}`,
    sourceType: "slack_list_item",
    body: title,
    observedAt,
    meta: { listId, cells: fields },
    fingerprint: JSON.stringify(fields),
  };
}

/** How the connector obtains a Slack client (overridable in tests). */
export type SlackClientFactory = (token: string) => Promise<SlackClientLike> | SlackClientLike;

/** Default factory: lazy-imports `@slack/web-api` so registration stays import-clean. */
export const defaultSlackClientFactory: SlackClientFactory = async (token) => {
  const { WebClient } = await import("@slack/web-api");
  const web = new WebClient(token);
  const like = web as unknown as SlackClientLike;
  // `slackLists.items.list` isn't a typed method on the SDK; go through apiCall.
  like.slackListsItems = (args) =>
    web.apiCall("slackLists.items.list", args) as Promise<{
      items?: SlackListItem[];
      response_metadata?: { next_cursor?: string };
    }>;
  return like;
};

export interface SlackConnectorOptions {
  /** Slack client factory override (tests inject a fake; default lazy-imports the SDK). */
  clientFactory?: SlackClientFactory;
  /** Clock (ms) for resolving the relative `since` floor; injectable for tests. */
  now?: () => number;
  /**
   * `users.info` transport for author display-name resolution (ADR-0037 §2).
   * Tests inject a fake; the default goes through the shared rate-limit-aware
   * `slackFetch` (ADR-0019), so registration stays import-clean.
   */
  usersTransport?: SlackUsersTransport;
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

/**
 * The stored cursor as an alias → channel → ts map (ADR-0016 `slack status` /
 * `slack cursor reset` read this). A bare-ts legacy cursor has no per-channel
 * structure and yields `{}`.
 */
export function cursorToAliasMap(raw: string | null): Record<string, Record<string, string>> {
  return parseCursor(raw).byAlias;
}

/** Serialize an alias → channel → ts map back to a cursor string (empty → `null`). */
export function serializeCursor(map: Record<string, Record<string, string>>): string | null {
  const out: Record<string, Record<string, string>> = {};
  for (const [alias, channels] of Object.entries(map)) {
    if (Object.keys(channels).length > 0) out[alias] = channels;
  }
  return Object.keys(out).length > 0 ? JSON.stringify(out) : null;
}

/** Per-workspace outcome of a sync pass, used to build the summary (ADR-0014). */
type WorkspaceStatus = "ok" | "failed" | "skipped";

/** Slack connector implementing the read-only contract (ADR-0007 / ADR-0014). */
class SlackConnector implements Connector {
  readonly name = SLACK_CONNECTOR_NAME;
  readonly sourceType = "slack";

  /** Per-alias → per-channel highest `ts` observed this run → next-run cursor. */
  private cursors: Record<string, Record<string, string>> = {};

  /**
   * Per-workspace status for this run (insertion order = config order), used to
   * build the end-of-run summary line and decide the partial-failure flag
   * (ADR-0014 / #166). Reset at the start of each `sync`.
   */
  private workspaceStatus: { alias: string; status: WorkspaceStatus }[] = [];

  constructor(
    private readonly config: SlackConnectorConfig,
    private readonly clientFactory: SlackClientFactory,
    private readonly now: () => number = () => Date.now(),
    private readonly usersTransport: SlackUsersTransport = defaultUsersTransport,
  ) {}

  async *sync(ctx: SyncContext): AsyncIterable<SourceRecord> {
    // Keep any workspace that has channels (messages) OR lists (read-back, §6).
    const workspaces = resolveWorkspaces(this.config).filter(
      (w) => w.channels.length > 0 || w.lists.length > 0,
    );
    if (workspaces.length === 0) return;

    const { byAlias: previous, legacyFloor } = parseCursor(ctx.cursor);
    // Start empty and seed only configured aliases/channels below, so cursors
    // for workspaces/channels removed from config don't accumulate forever.
    this.cursors = {};
    this.workspaceStatus = [];
    let resolvedCount = 0; // workspaces that had a token
    let failedCount = 0; // workspaces that errored mid-fetch
    let lastError: unknown;

    // Surface non-id channel values (e.g. a `#general` name) before any fetch:
    // `conversations.history` keys off the id, so a name silently ingests zero
    // messages. Warn (don't fail) so a future-valid id prefix is never locked
    // out (ADR-0007 "no silent wrong answer", Issue #158).
    for (const ws of workspaces) {
      for (const channel of ws.channels) {
        if (!looksLikeSlackChannelId(channel)) {
          ctx.onWarn?.(
            `workspace '${ws.alias}' channel '${channel}' does not look like a Slack id ` +
              "(ids start with C/D/G) — channels must be ids, not names; run " +
              "`suasor slack conversations` to find the id",
          );
        }
      }
    }

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
        this.workspaceStatus.push({ alias: ws.alias, status: "skipped" });
        continue;
      }
      resolvedCount += 1;
      const prevChannels = previous[ws.alias] ?? {};

      try {
        const client = await this.clientFactory(token);
        const aliasCursors: Record<string, string> = {};
        // Per-workspace author-name cache (ADR-0037 §5): the same `Uxxxx`
        // resolves `users.info` at most once per workspace this run. Keyed by
        // this workspace's token so ids never cross-resolve between workspaces.
        const nameCache = new Map<string, string | null>();
        // Per-workspace channel-name cache (ADR-0037 §3/§5): each channel id is
        // resolved via `conversations.info` (+ members for group DMs) at most once
        // this run. Shares `nameCache` for DM / group-DM participant names.
        const channelCache = new Map<string, ResolvedChannel>();
        // Channels this run could not reach (not_in_channel / channel_not_found /
        // is_archived): collected per channel and surfaced as one aggregated warn
        // so READY-but-unjoined channels are no longer silently empty (ADR-0011).
        const unreachable: { channel: string; code: string }[] = [];

        // The default workspace's legacy floor (bare-ts cursor pre-ADR-0011).
        const legacy =
          ws.alias === DEFAULT_WORKSPACE_ALIAS ? (legacyFloor ?? undefined) : undefined;

        for (const channel of ws.channels) {
          // Cold-start floor (ADR-0016 / #57): a per-channel `since` override
          // wins over the workspace `since`, combined with the legacy floor.
          // Applied only to channels with no saved cursor (a resumed channel
          // keeps its own high-water mark).
          const sinceStr = ws.channelSince?.[channel] ?? ws.since;
          const sinceFloor = sinceStr
            ? (parseSinceToTs(sinceStr, this.now()) ?? undefined)
            : undefined;
          const floor = higherTs(sinceFloor, legacy);
          // Each channel resumes from its OWN high-water mark; a never-synced
          // channel starts at the floor so cold-start stays bounded.
          const oldest = prevChannels[channel] ?? floor;
          try {
            for await (const item of fetchChannelItems(client, channel, oldest)) {
              // History messages and thread replies advance the same per-channel
              // cursor — the highest ts seen (a reply may be newest) resumes next run.
              const seen = aliasCursors[channel];
              if (seen === undefined || Number.parseFloat(item.ts) > Number.parseFloat(seen)) {
                aliasCursors[channel] = item.ts;
              }
              // Resolve the author id → display name at sync time so the person
              // projection carries a human name (ADR-0037 §2). Best-effort: a
              // failed resolution (missing `users:read`, API error) returns null
              // → `meta.userName` unset, ingest continues (ADR-0037 §6 degrade).
              const userName = item.user
                ? await resolveUserName(token, item.user, this.usersTransport, nameCache)
                : null;
              // Resolve the channel name + kind at sync time so the
              // slack_channels projection carries a human name (ADR-0037 §3).
              // Cached per run; best-effort degrade to id-only (§6) never blocks
              // ingest. Reuses `nameCache` for DM / group-DM participant names.
              const channelInfo = await resolveChannel(
                client,
                token,
                channel,
                ws.selfUserId,
                this.usersTransport,
                nameCache,
                channelCache,
              );
              yield toRecord(ws.team, channel, item, userName, channelInfo);
            }
          } catch (error) {
            // A channel-scoped unreachable error (not_in_channel etc.) must not
            // abort the workspace's other channels: record it for the aggregated
            // warn, preserve any prior cursor, and move on. Other errors
            // (ratelimited, auth, network) are workspace-wide → rethrow to the
            // per-workspace isolation below (#56).
            const code = unreachableChannelCode(error);
            if (code === null) throw error;
            unreachable.push({ channel, code });
            if (prevChannels[channel]) aliasCursors[channel] = prevChannels[channel];
            continue;
          }

          // Preserve the floor for a channel with no new messages so it is not
          // re-scanned from scratch on the next run.
          if (aliasCursors[channel] === undefined && oldest !== undefined) {
            aliasCursors[channel] = oldest;
          }
        }
        this.cursors[ws.alias] = aliasCursors;
        this.workspaceStatus.push({ alias: ws.alias, status: "ok" });

        // One aggregated warn naming every unreachable channel (which, and why),
        // so the operator sees the membership gap instead of a silent empty sync.
        if (unreachable.length > 0) {
          const detail = unreachable.map((u) => `${u.channel} (${u.code})`).join(", ");
          ctx.onWarn?.(
            `workspace '${ws.alias}': ${unreachable.length} channel(s) unreachable — ${detail}; ` +
              "the bot must join the channel (or be /invite'd) to ingest it",
          );
        }
      } catch (error) {
        // Mid-fetch isolation (#56): a fetch failure in one workspace must not
        // abort the others. Surface it as a warning and preserve this alias's
        // prior cursor (its configured channels) so the failure isn't a reset.
        failedCount += 1;
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        ctx.onWarn?.(`workspace '${ws.alias}' failed mid-sync: ${message}`);
        const preserved: Record<string, string> = {};
        for (const channel of ws.channels) {
          if (prevChannels[channel]) preserved[channel] = prevChannels[channel];
        }
        if (Object.keys(preserved).length > 0) this.cursors[ws.alias] = preserved;
        this.workspaceStatus.push({ alias: ws.alias, status: "failed" });
      }
    }

    // Mirror configured Slack Lists as `slack_list_item` sources (ADR-0036 §6
    // read-back), per workspace (each its own token). Raw cells only —
    // `reconcileReadback` interprets them with the [tasks.home] column config.
    // Best-effort: a per-list / token failure warns, not aborts.
    yield* this.syncLists(ctx, workspaces);

    if (resolvedCount === 0 && workspaces.some((w) => w.channels.length > 0)) {
      throw new Error(
        "slack connector: no token configured for any workspace " +
          "(set SUASOR_CONNECTOR_SLACK_TOKEN or run `suasor slack auth set`)",
      );
    }
    // Every workspace that had a token failed → surface the error rather than
    // reporting a silent success. A partial failure (some succeeded) is isolated.
    if (failedCount > 0 && failedCount === resolvedCount) {
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }
  }

  /**
   * Ingest the configured Slack Lists' items as `slack_list_item` sources (raw
   * cells, ADR-0036 §6). Uses the flat/default token. Paginated; per-list errors
   * warn (best-effort) rather than aborting the sync.
   */
  private async *syncLists(
    ctx: SyncContext,
    workspaces: ResolvedWorkspace[],
  ): AsyncIterable<SourceRecord> {
    const observedAt = new Date().toISOString();
    for (const ws of workspaces) {
      if (ws.lists.length === 0) continue;
      const token = await ctx.secret(ws.secretName);
      if (!token) {
        ctx.onWarn?.(`workspace '${ws.alias}' lists skipped: no token (needs \`lists:read\`)`);
        continue;
      }
      const client = await this.clientFactory(token);
      if (!client.slackListsItems) continue; // a fake without list support
      for (const listId of ws.lists) {
        try {
          let cursor: string | undefined;
          do {
            const res = await client.slackListsItems({
              list_id: listId,
              limit: 100,
              ...(cursor ? { cursor } : {}),
            });
            for (const item of res.items ?? []) {
              if (!item.id) continue;
              yield listItemToRecord(listId, item, observedAt);
            }
            cursor = res.response_metadata?.next_cursor || undefined;
          } while (cursor);
        } catch (error) {
          ctx.onWarn?.(
            `slack list '${listId}' (${ws.alias}) failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
  }

  finalize(): SyncResult {
    const cursor = serializeCursor(this.cursors);
    // No multi-workspace status to report (e.g. an empty/no-channel config that
    // returned before the loop): keep the result minimal, no summary line.
    if (this.workspaceStatus.length === 0) return { cursor };

    // One summary line naming each workspace's outcome (ADR-0014 / #166), e.g.
    // `slack: acme=ok, beta=failed (cursor preserved), gamma=skipped (no token)`.
    // A failed workspace's prior cursor is preserved (the failure is not a
    // reset) — annotate it so an operator reads the recovery state inline.
    const parts = this.workspaceStatus.map(({ alias, status }) => {
      if (status === "failed") return `${alias}=failed (cursor preserved)`;
      if (status === "skipped") return `${alias}=skipped (no token)`;
      return `${alias}=ok`;
    });
    const summaryLines = [`workspaces: ${parts.join(", ")}`];

    // A partial failure: at least one workspace failed AND at least one did not
    // (a clean run is all-ok/skipped; an all-failed run already threw upstream so
    // finalize is never reached). The caller turns this into a non-zero exit so a
    // partial failure is not hidden behind exit 0 in cron / CI (ADR-0027, #166).
    const failed = this.workspaceStatus.filter((w) => w.status === "failed").length;
    const partialFailure = failed > 0 && failed < this.workspaceStatus.length;

    return { cursor, partialFailure, summaryLines };
  }
}

/**
 * Stream a channel's messages: `conversations.history` pages, and for every
 * thread parent (`reply_count > 0`) the thread's replies via
 * `conversations.replies` (ADR-0015). Replies are interleaved right after their
 * parent. Only parents with replies are expanded, so quiet messages cost no
 * extra API call (N+1 guard).
 */
async function* fetchChannelItems(
  client: SlackClientLike,
  channel: string,
  oldest: string | undefined,
): AsyncIterable<SlackMessageItem> {
  let cursor: string | undefined;
  do {
    const page = await client.conversations.history({
      channel,
      limit: 200,
      ...(oldest ? { oldest } : {}),
      ...(cursor ? { cursor } : {}),
    });
    for (const item of page.messages ?? []) {
      yield item;
      if (item.reply_count && item.reply_count > 0) {
        yield* fetchThreadReplies(client, channel, item.ts, oldest);
      }
    }
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
}

/**
 * Stream a thread's replies for parent `parentTs`. Slack returns the parent as
 * the first element of `conversations.replies`; it is skipped here because the
 * caller already yielded it from `history` (no duplicate `SourceRecord`).
 */
async function* fetchThreadReplies(
  client: SlackClientLike,
  channel: string,
  parentTs: string,
  oldest: string | undefined,
): AsyncIterable<SlackMessageItem> {
  let cursor: string | undefined;
  do {
    const page = await client.conversations.replies({
      channel,
      ts: parentTs,
      limit: 200,
      ...(oldest ? { oldest } : {}),
      ...(cursor ? { cursor } : {}),
    });
    for (const item of page.messages ?? []) {
      if (item.ts !== parentTs) yield item; // skip the parent echo
    }
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
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
  // Fail fast on an unparseable `since` / `channel_since` floor rather than
  // letting it silently degrade to "no floor" mid-sync (ADR-0007, Issue #157).
  validateSlackSince(parsed);
  return new SlackConnector(
    parsed,
    options.clientFactory ?? defaultSlackClientFactory,
    options.now,
    options.usersTransport ?? defaultUsersTransport,
  );
}
