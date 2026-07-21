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
 * - **identity** — `slack:<channel>:<ts>` (canonical, ADR-0042: channel ids are
 *   globally unique across Slack, so no team prefix — a channel shared across
 *   workspaces collapses to one source lineage). `source_type` is `slack_message`.
 * - **import-clean** — `@slack/web-api` is **lazy-imported inside `sync`**, so
 *   building the connector / registry never pulls the SDK (ADR-0007, NFR-PRF-1).
 *   This module's top-level imports are limited to `zod` + the contract types.
 * - **secrets** — tokens come from the unnamed pool `ctx.secret("tokens")`
 *   (keychain + env override, newline/comma separated, ADR-0042 / NFR-PRV-4);
 *   they are never read from config.
 */
import { z } from "zod";
import { ConfigError } from "../config/error.ts";
import type {
  Connector,
  ConnectorConfig,
  CredentialRequirement,
  SourceRecord,
  SyncContext,
  SyncResult,
} from "./contract.ts";
import type { ConnectorManifest } from "./manifest.ts";
import { type ResolvedChannel, resolveChannel } from "./slack/channel.ts";
import {
  type ConversationType,
  diffConversations,
  listConversations,
  type SlackConversationsTransport,
} from "./slack/conversations.ts";
import {
  defaultUsersTransport,
  resolveUserName,
  type SlackUsersTransport,
} from "./slack/resolve.ts";
import { resolveTeamName } from "./slack/team.ts";

/**
 * `[connectors.slack]` config (docs/design/config.md, ADR-0042): one flat
 * channel list. The ADR-0014 workspace tables (`workspaces.<alias>`, per-alias
 * `team` / `self_user_id` / tokens) were removed by ADR-0042 — tokens live in an
 * unnamed pool (`connector:slack:tokens`) and each channel is fetched via
 * whichever token can reach it. Channel ids are globally unique, so no
 * workspace classification is needed in config.
 */
export const SlackConnectorConfig = z.object({
  /** Channel ids to ingest (e.g. "C0123ABCD"); globally unique across the Grid. */
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
   * (`30d` / `2026-01-01`) that takes precedence over the connector-level
   * `since` for those channels. Channels not listed fall back to `since`.
   */
  channel_since: z.record(z.string(), z.string().min(1)).optional(),
  /**
   * The operator's own Slack user ids (`Uxxxx`, one per workspace they exist
   * in), used by `demand.list` to detect `<@you>` mentions (ADR-0012 /
   * ADR-0042 決定 2). Resolve them from `slack auth test` (each user token's
   * `userId`). Optional: without any, demand falls back to DM-only.
   */
  self_user_ids: z.array(z.string().min(1)).optional(),
  /**
   * Slack List ids to mirror as `slack_list_item` sources for task read-back
   * (ADR-0036 §6). The items are ingested with **raw cells** (no interpretation);
   * `reconcileReadback` maps them to a task state using `[tasks.homes.slack]`
   * column ids. Fetched via whichever pool token can reach the list (`lists:read`).
   */
  lists: z.array(z.string().min(1)).optional(),
  /**
   * Whether `slack sync` sweeps for newly-joined conversations not yet in
   * `channels` and warns about the drift (ADR-0039 Layer 2). Default `true`;
   * connector-level only (the ADR-0014 per-alias override is gone). The sweep is
   * cadence-gated (once per 24h) and never ingests — it only surfaces a one-line
   * warn pointing at `slack conversations --new` (cursor unchanged).
   */
  discover_new: z.boolean().optional(),
});
export type SlackConnectorConfig = z.infer<typeof SlackConnectorConfig>;

/**
 * Config keys of the superseded ADR-0014 multi-workspace shape. Detected at
 * connector build time so an un-migrated config fails loudly with migration
 * guidance instead of silently ignoring the removed keys (ADR-0007 "no silent
 * wrong answer"; ADR-0042 決定 9 deliberately ships no automatic conversion).
 */
const LEGACY_WORKSPACE_KEYS = ["workspaces", "team", "self_user_id"] as const;

/**
 * Fail fast when the config slice still uses the removed ADR-0014 shape
 * (`workspaces` tables / `team` / `self_user_id`). The error names each legacy
 * key and the flat replacement so the migration is mechanical.
 */
export function rejectLegacySlackConfig(config: ConnectorConfig): void {
  const raw = (config ?? {}) as Record<string, unknown>;
  const present = LEGACY_WORKSPACE_KEYS.filter((k) => raw[k] !== undefined);
  if (present.length === 0) return;
  throw new ConfigError("legacy Slack multi-workspace config (removed by ADR-0042)", [
    `connectors.slack: remove ${present.map((k) => `'${k}'`).join(", ")} — the workspace-less shape is a single flat [connectors.slack] with 'channels' (merge every workspace's channel ids into one list), optional 'self_user_ids' (replaces per-workspace self_user_id), and one token pool: keychain 'connector:slack:tokens' via \`suasor slack auth set\`, or env SUASOR_CONNECTOR_SLACK_TOKENS (newline/comma separated). Per-alias 'since' moves to [connectors.slack.channel_since]. See docs/adr/0042-slack-workspace-less-connector.md.`,
  ]);
}

/**
 * The operator's Slack user ids from the connector config slice (ADR-0012 /
 * ADR-0042 決定 2). Used by the `demand.list` / `priority.list` MCP tools to
 * detect `<@you>` mentions. Empty when none configured → DM-only demand
 * (`slack auth test` prints each user token's own user id to paste here).
 */
export function resolveSelfUserIds(config: ConnectorConfig): string[] {
  const parsed = SlackConnectorConfig.parse(config ?? {});
  return [...new Set(parsed.self_user_ids ?? [])];
}

export const SLACK_CONNECTOR_NAME = "slack";

/**
 * The single keychain secret name of the unnamed token pool (ADR-0042 決定 2):
 * keychain account `connector:slack:tokens`, env override
 * `SUASOR_CONNECTOR_SLACK_TOKENS` (derived by `secretEnvName`). The stored value
 * is a newline- or comma-separated token list; writes are **replace-all** so a
 * dead token never lingers by accident.
 */
export const SLACK_TOKENS_SECRET = "tokens";

/**
 * Parse the stored token pool: split on newlines / commas, trim, drop empties,
 * and de-duplicate preserving order (a token pasted twice — or two tokens for
 * the same workspace — is harmless; the first occurrence wins).
 */
export function parseTokenPool(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\n,]/)) {
    const token = part.trim();
    if (token.length === 0 || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

/**
 * Credential precondition (ADR-0007 "credential 解決は scope-emptiness 判定に先行
 * する", Issue #440): the single pool secret must resolve. Individual dead
 * tokens inside the pool are handled by the connector's own per-token isolation.
 */
export function slackCredentials(): CredentialRequirement {
  return {
    secretNames: [SLACK_TOKENS_SECRET],
    missingMessage:
      "slack connector: no token pool configured " +
      "(set SUASOR_CONNECTOR_SLACK_TOKENS — newline/comma separated — or run `suasor slack auth set`)",
  };
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

  // Recovery hint (Issue #380): once the floor is corrected, older history can be
  // re-fetched with the `slack cursor backfill` verb. `channel_since` embeds its
  // concrete channel while the connector-level `since` (which spans every
  // channel) uses a `<channel-id>` placeholder.
  const backfillHint = (channel: string): string =>
    `Tip: after correcting it, backfill older history with 'suasor slack cursor backfill --channel ${channel} --since <floor> --yes'`;

  const checkSince = (value: string | undefined, label: string, channel: string): void => {
    if (value !== undefined && !isSinceParseable(value)) {
      issues.push(
        `${label}: invalid since '${value}' (expected relative '30d'/'4w'/'12h' or ISO date '2026-01-01'). ${backfillHint(channel)}`,
      );
    }
  };

  checkSince(config.since, "connectors.slack.since", "<channel-id>");
  for (const [channel, value] of Object.entries(config.channel_since ?? {})) {
    checkSince(value, `connectors.slack.channel_since.${channel}`, channel);
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

/**
 * The `users.conversations` types the reachability sweep needs for the given
 * configured channels (#470): derived from the id prefixes so a pool sweep never
 * pages types no configured channel can be. `C…` covers public AND private
 * (modern private channels use the C prefix), `G…` covers legacy private groups
 * and group-DMs, `D…` covers DMs. An unrecognised prefix (already warned as a
 * likely misconfiguration) falls back to all four types — the sweep is advisory
 * ordering, so over-sweeping is safe and under-sweeping never excludes (the
 * candidates fall back to the pool, ADR-0042 決定 3).
 */
export function sweepTypesForChannels(channels: readonly string[]): ConversationType[] {
  const ALL: ConversationType[] = ["public", "private", "im", "mpim"];
  const out = new Set<ConversationType>();
  for (const channel of channels) {
    const head = channel.trim().charAt(0).toUpperCase();
    if (head === "C") {
      out.add("public");
      out.add("private");
    } else if (head === "G") {
      out.add("private");
      out.add("mpim");
    } else if (head === "D") {
      out.add("im");
    } else {
      return ALL; // unknown prefix — sweep everything (safe fallback)
    }
  }
  return ALL.filter((t) => out.has(t));
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
 *
 * `teamName` is the sync-time-resolved workspace name (ADR-0037 §3/§10, Issue
 * #361): stored under `meta.teamName` only when a non-empty name was resolved, so
 * `teamFromMeta` can fold a `SlackTeamObserved` (an absent name degrades to the
 * team id fallback at display).
 */
function toRecord(
  team: string | undefined,
  channel: string,
  item: SlackMessageItem,
  userName?: string | null,
  channelInfo?: ResolvedChannel,
  teamName?: string | null,
): SourceRecord {
  return {
    // Canonical identity (ADR-0042): channel ids are globally unique across
    // Slack, so the externalId carries no team prefix — the same message
    // observed via any workspace/token collapses to one source. `team` stays a
    // display facet under `meta` (ADR-0037 revision note).
    externalId: `slack:${channel}:${item.ts}`,
    sourceType: "slack_message",
    body: item.text ?? "",
    // Slack `ts` is `<unix-seconds>.<microseconds>`; expose it as ISO 8601.
    observedAt: new Date(Math.floor(Number.parseFloat(item.ts) * 1000)).toISOString(),
    meta: {
      ...(team ? { team } : {}),
      channel,
      ts: item.ts,
      user: item.user ?? null,
      ...(userName ? { userName } : {}),
      ...(teamName ? { teamName } : {}),
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
  /**
   * `auth.test` — the token's own team id / name, for team-name resolution
   * (ADR-0037 §10, Issue #361). Optional so existing message-only fakes need not
   * implement it — team-name resolution then degrades to id-only (no live fetch).
   */
  authTest?: () => Promise<{ ok?: boolean; team?: string; team_id?: string; user_id?: string }>;
  /**
   * `auth.teams.list` — Enterprise Grid workspace enumeration for team names
   * (ADR-0037 §10, Issue #361). Optional; a fake without it (or a non-Grid token)
   * falls back to `authTest` for the single team.
   */
  authTeamsList?: (args: { cursor?: string; limit?: number }) => Promise<{
    ok?: boolean;
    teams?: Array<{ id?: string; name?: string }>;
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
 * with the `[tasks.homes.slack]` column config. The fingerprint hashes the cells so a
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
  // Team-name resolution (ADR-0037 §10, Issue #361): `auth.test` for the token's
  // own team, `auth.teams.list` (untyped → apiCall) for Grid enumeration.
  like.authTest = () =>
    web.auth.test() as Promise<{ ok?: boolean; team?: string; team_id?: string; user_id?: string }>;
  like.authTeamsList = (args) =>
    web.apiCall("auth.teams.list", args) as Promise<{
      ok?: boolean;
      teams?: Array<{ id?: string; name?: string }>;
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
  /**
   * `users.conversations` transport for the discovery-drift sweep (ADR-0039
   * Layer 2). Tests inject a fake so the sweep is network-free; the default goes
   * through the shared rate-limit-aware `slackFetch` (ADR-0019).
   */
  conversationsTransport?: SlackConversationsTransport;
}

/**
 * Reserved cursor key that carries the discovery-drift marker (ADR-0039 Layer
 * 2), stashed inside the connector's own opaque cursor so it needs no extra
 * projection / event wiring. Its value is `"<lastSweptEpochMs>:<newCount>"`
 * (pool-wide — the per-workspace cadence went away with the aliases). The
 * `__…__` prefix cannot collide with a channel id, and
 * {@link cursorToChannelMap} strips it so `slack status` / `cursor reset` /
 * `cursor backfill` never see or clobber it.
 */
const DISCOVERY_CURSOR_KEY = "__discovery__";

/**
 * Parse the resume cursor into a flat channel → high-water-mark map (ADR-0042;
 * per-thread `<channel>#<thread_ts>` keys sit alongside, ADR-0015 R1). Three
 * input shapes are accepted:
 * - **flat** `{ "<channel>": "<ts>" }` — the current format.
 * - **nested** `{ "<alias>": { "<channel>": "<ts>" } }` — the superseded
 *   ADR-0014 per-alias format; flattened by taking the **max ts per channel**
 *   across aliases (deterministic, one-time — avoids a cold restart on upgrade).
 *   The legacy nested discovery marker is dropped (the sweep just re-runs once).
 * - **bare ts** — the pre-per-channel legacy cursor (ADR-0011); returned as a
 *   `legacyFloor` applied to every channel on the first run.
 */
function parseCursor(raw: string | null): {
  channels: Record<string, string>;
  legacyFloor: string | null;
} {
  if (!raw) return { channels: {}, legacyFloor: null };
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return { channels: {}, legacyFloor: trimmed };
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const channels: Record<string, string> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === "string") {
        channels[key] = value; // flat entry (channel, thread key, or marker)
      } else if (value && typeof value === "object") {
        // Superseded nested alias map (ADR-0014) → flatten with max-ts merge.
        // The old discovery marker nested under this key holds `"<ms>:<count>"`
        // values that are not ts — skip the whole reserved key.
        if (key === DISCOVERY_CURSOR_KEY) continue;
        for (const [ch, ts] of Object.entries(value)) {
          if (typeof ts !== "string") continue;
          const prev = channels[ch];
          channels[ch] = prev === undefined ? ts : maxTs(prev, ts);
        }
      }
    }
    return { channels, legacyFloor: null };
  } catch {
    // Unparseable cursor → treat as a fresh start rather than crash.
    return { channels: {}, legacyFloor: null };
  }
}

/**
 * The stored cursor as a flat channel → ts map (ADR-0016 `slack status` /
 * `slack cursor reset` read this). A bare-ts legacy cursor has no per-channel
 * structure and yields `{}`. The reserved discovery marker
 * ({@link DISCOVERY_CURSOR_KEY}) is stripped so the recovery verbs that
 * re-serialize this map never surface or drop it as if it were a channel.
 */
export function cursorToChannelMap(raw: string | null): Record<string, string> {
  const { [DISCOVERY_CURSOR_KEY]: _discovery, ...channels } = parseCursor(raw).channels;
  return channels;
}

/** Serialize a flat channel → ts map back to a cursor string (empty → `null`). */
export function serializeCursor(map: Record<string, string>): string | null {
  return Object.keys(map).length > 0 ? JSON.stringify(map) : null;
}

/**
 * Separator between a channel id and a thread's `thread_ts` in a per-thread
 * cursor key (`<channel>#<thread_ts>`, ADR-0015 R1). Channel ids (C/D/G…) never
 * contain `#` and a `thread_ts` is `<seconds>.<micros>`, so splitting on the
 * first `#` unambiguously recovers both halves — letting a thread's high-water
 * mark sit alongside the plain `<channel>` key in the same per-alias map.
 */
const THREAD_CURSOR_SEP = "#";

/** Build the `<channel>#<thread_ts>` per-thread cursor key (ADR-0015 R1). */
export function threadCursorKey(channel: string, threadTs: string): string {
  return `${channel}${THREAD_CURSOR_SEP}${threadTs}`;
}

/**
 * Parse a per-alias cursor entry key. A plain channel key (`C123`) returns
 * `null`; a per-thread key (`C123#170…`) returns its `{ channel, threadTs }`
 * halves. Lets the sync loop and the operational verbs (`slack status` /
 * `cursor reset` / `cursor backfill`) tell the two kinds apart within one alias
 * map (ADR-0015 R1).
 */
export function parseThreadCursorKey(key: string): { channel: string; threadTs: string } | null {
  const idx = key.indexOf(THREAD_CURSOR_SEP);
  if (idx < 0) return null;
  return { channel: key.slice(0, idx), threadTs: key.slice(idx + THREAD_CURSOR_SEP.length) };
}

/**
 * How recently a thread must have had activity to keep being re-polled
 * (ADR-0015 R1). A thread whose last captured reply is older than this is pruned
 * — its per-thread cursor is dropped and it is no longer re-polled — so the
 * added `conversations.replies` calls stay bounded to truly-active threads.
 * Default 30 days.
 */
const ACTIVE_THREAD_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Whether a thread's high-water-mark `ts` is recent enough (within
 * {@link ACTIVE_THREAD_WINDOW_MS} of `nowMs`) to keep re-polling it (ADR-0015
 * R1). A Slack `ts` is wall-clock `<unix-seconds>.<micros>`, so this doubles as
 * the inactivity prune test. Exported for direct unit testing.
 */
export function isThreadActive(hwmTs: string, nowMs: number): boolean {
  const floorSeconds = Math.floor(nowMs / 1000) - Math.floor(ACTIVE_THREAD_WINDOW_MS / 1000);
  return Number.parseFloat(hwmTs) >= floorSeconds;
}

/** The more recent (numerically larger) of two defined ts values. */
function maxTs(a: string, b: string): string {
  return Number.parseFloat(a) >= Number.parseFloat(b) ? a : b;
}

/** The pool-wide persisted discovery-drift marker (ADR-0039 Layer 2 / ADR-0042). */
export interface DiscoveryMarker {
  /** Epoch ms of the last discovery sweep (drives the 24h cadence). */
  readonly lastSweptMs: number;
  /** New (member, not-yet-configured) conversations the sweep found. */
  readonly newCount: number;
}

/** Parse one `"<epochMs>:<count>"` marker value, or `null` when malformed. */
function parseDiscoveryMarkerValue(
  value: string,
): { lastSweptMs: number; newCount: number } | null {
  const idx = value.indexOf(":");
  if (idx < 0) return null;
  const lastSweptMs = Number(value.slice(0, idx));
  const newCount = Number(value.slice(idx + 1));
  if (!Number.isFinite(lastSweptMs) || !Number.isFinite(newCount)) return null;
  return { lastSweptMs, newCount };
}

/**
 * Read the pool-wide discovery-drift marker the sync sweep persisted into the
 * connector cursor (ADR-0039 Layer 2). Offline: parses the stored cursor, with
 * no network. Used by `suasor doctor` to surface "N new Slack conversation(s)
 * not in config" without sweeping the network itself. Returns `null` when no
 * sweep has run — including when the cursor predates ADR-0042 and only carries
 * the old per-alias nested marker, which is dropped (the sweep re-runs once).
 */
export function readDiscoveryMarker(raw: string | null): DiscoveryMarker | null {
  const value = parseCursor(raw).channels[DISCOVERY_CURSOR_KEY];
  if (!value) return null;
  return parseDiscoveryMarkerValue(value);
}

/**
 * Conversation types the sync-time discovery sweep enumerates (ADR-0039 §3):
 * public + private only. DMs / group-DMs are excluded by default — they are
 * noisy and better surfaced on the explicit `slack conversations --new --types`
 * path, not a routine sync warn.
 */
const DISCOVERY_SWEEP_TYPES: readonly ConversationType[] = ["public", "private"];

/** Cadence for the discovery sweep (ADR-0039 §3): at most once per 24h (pool-wide). */
const DISCOVERY_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * One pool token resolved for this run: its client plus the `auth.test`
 * self-description (ADR-0042 決定 2). `teamId` / `teamName` / `userId` stay
 * undefined when the client exposes no `authTest` (test fakes) — the token is
 * still usable; labels and `meta.team` then degrade to the pool position.
 */
interface TokenIdentity {
  readonly token: string;
  readonly client: SlackClientLike;
  /** 1-based pool position, the label of last resort. */
  readonly index: number;
  readonly teamId?: string;
  readonly teamName?: string;
  /** The token's own user id (`auth.test`), excluded from group-DM name joins. */
  readonly userId?: string;
  /** Set when a token-wide failure (auth / rate limit / network) occurs mid-run. */
  failed: boolean;
}

/** Human label for a token in warns / the summary: name > team id > position. */
function tokenLabel(t: { index: number; teamId?: string; teamName?: string }): string {
  if (t.teamName) return t.teamId ? `${t.teamId} "${t.teamName}"` : t.teamName;
  return t.teamId ?? `#${t.index}`;
}

/** Per-token outcome of a sync pass, used to build the summary (ADR-0042 決定 5). */
type TokenStatus = "ok" | "dead" | "failed";

/** Slack connector implementing the read-only contract (ADR-0007 / ADR-0042). */
class SlackConnector implements Connector {
  readonly name = SLACK_CONNECTOR_NAME;
  readonly sourceType = "slack";
  /** The single pool secret; enforced centrally (#440). */
  readonly credentials: CredentialRequirement;

  /** Flat channel → highest `ts` observed this run → next-run cursor. */
  private cursors: Record<string, string> = {};

  /**
   * Per-token status for this run (pool order), used to build the end-of-run
   * summary line and the partial-failure flag (ADR-0042 決定 5: a dead token —
   * replace it — is told apart from an unreachable channel — add a token).
   */
  private tokenStatus: { label: string; status: TokenStatus }[] = [];

  /** Channels no token could ingest this run (drives the partial-failure flag). */
  private failedChannelCount = 0;

  constructor(
    private readonly config: SlackConnectorConfig,
    private readonly clientFactory: SlackClientFactory,
    private readonly now: () => number = () => Date.now(),
    private readonly usersTransport: SlackUsersTransport = defaultUsersTransport,
    /** Sweep transport for discovery + reachability (ADR-0039/0042); default `slackFetch`. */
    private readonly conversationsTransport?: SlackConversationsTransport,
  ) {
    this.credentials = slackCredentials();
  }

  async *sync(ctx: SyncContext): AsyncIterable<SourceRecord> {
    const cfg = this.config;
    const channels = cfg.channels;
    const lists = cfg.lists ?? [];
    this.cursors = {};
    this.tokenStatus = [];
    this.failedChannelCount = 0;
    if (channels.length === 0 && lists.length === 0) return;

    // The pool secret resolves centrally before sync runs (#440 — runSyncPass
    // enforces `Connector.credentials`, so an empty pool cannot reach this code
    // in production; #458 dropped the redundant defense-in-depth throw here).
    // Parse it into individual tokens (newline/comma separated, ADR-0042 決定 2).
    const pool = parseTokenPool(await ctx.secret(SLACK_TOKENS_SECRET));

    // Surface non-id channel values (e.g. a `#general` name) before any fetch:
    // `conversations.history` keys off the id, so a name silently ingests zero
    // messages. Warn (don't fail) so a future-valid id prefix is never locked
    // out (ADR-0007 "no silent wrong answer", Issue #158).
    for (const channel of channels) {
      if (!looksLikeSlackChannelId(channel)) {
        ctx.onWarn?.(
          `channel '${channel}' does not look like a Slack id ` +
            "(ids start with C/D/G) — channels must be ids, not names; run " +
            "`suasor slack conversations` to find the id",
        );
      }
    }

    const { channels: prevAll, legacyFloor } = parseCursor(ctx.cursor);
    const prevMarker = prevAll[DISCOVERY_CURSOR_KEY];
    delete prevAll[DISCOVERY_CURSOR_KEY];
    const prevChannels = prevAll;
    const nowMs = this.now();

    // 1. Self-describe each token via `auth.test` when the client exposes it
    // (ADR-0042 決定 2); a fake without `authTest` stays usable with an unknown
    // identity. A failing `auth.test` = a **dead token**: it is excluded from
    // this run and named in one warn + the summary (決定 5 — the recovery is
    // "replace it", distinct from an unreachable channel's "add a token").
    const identities: TokenIdentity[] = [];
    for (const [i, token] of pool.entries()) {
      const client = await this.clientFactory(token);
      let described: Pick<TokenIdentity, "teamId" | "teamName" | "userId"> = {};
      if (client.authTest) {
        try {
          const res = await client.authTest();
          if (res.ok === false) throw new Error("auth.test returned ok:false");
          described = {
            ...(res.team_id ? { teamId: res.team_id } : {}),
            ...(res.team ? { teamName: res.team } : {}),
            ...(res.user_id ? { userId: res.user_id } : {}),
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.onWarn?.(
            `token #${i + 1} is dead (auth.test failed: ${message}) — replace the pool with ` +
              "`suasor slack auth set` / SUASOR_CONNECTOR_SLACK_TOKENS",
          );
          this.tokenStatus.push({ label: `#${i + 1}`, status: "dead" });
          continue;
        }
      }
      identities.push({ token, client, index: i + 1, failed: false, ...described });
    }
    // No live token: every pool token failed auth.test — or a direct
    // `connector.sync()` call bypassed the central credential precondition with
    // an empty pool (#440/#458). Either way nothing can be ingested; fail loudly
    // rather than yield a silent empty pass (ADR-0007).
    if (identities.length === 0) {
      throw new Error(
        "slack connector: no usable token in the pool (empty, or every token failed " +
          "auth.test) — replace it (`suasor slack auth set` / SUASOR_CONNECTOR_SLACK_TOKENS)",
      );
    }

    // 2. Discovery-drift sweep (ADR-0039 Layer 2), pool-wide cadence: the union
    // of every live token's visible-but-unconfigured conversations.
    const marker = await this.sweepDiscovery(ctx, identities, prevMarker);
    if (marker !== undefined) this.cursors[DISCOVERY_CURSOR_KEY] = marker;

    // 3. Reachability map (ADR-0042 決定 3): with 2+ live tokens, sweep each
    // token's joined conversations once so every channel is fetched via a token
    // that can actually read it. Best-effort: a failed sweep leaves that token's
    // reachability **unknown** (`null`) and it stays a candidate for every
    // channel — the bounded failover below absorbs a wrong pick. A single-token
    // pool skips the sweep entirely (the only token is the only candidate).
    const reach = new Map<TokenIdentity, Set<string> | null>();
    if (identities.length > 1) {
      // Sweep only the conversation types the configured channels can be
      // (derived from their id prefixes, #470) — no wasted paging over types
      // with nothing configured. Rate limits ride the shared retry (ADR-0019).
      const sweepTypes = sweepTypesForChannels(channels);
      for (const id of identities) {
        try {
          const { conversations } = await listConversations(id.token, {
            types: sweepTypes,
            ...(this.conversationsTransport ? { transport: this.conversationsTransport } : {}),
          });
          reach.set(id, new Set(conversations.filter((c) => c.isMember).map((c) => c.id)));
        } catch {
          reach.set(id, null);
        }
      }
    } else {
      reach.set(identities[0] as TokenIdentity, null);
    }

    // Pool-wide per-run caches (ADR-0037 §5): Slack ids are globally unique
    // within a Grid, so one cache spans every token this run.
    const nameCache = new Map<string, string | null>();
    const channelCache = new Map<string, ResolvedChannel>();
    const teamCache = new Map<string, string | null>();

    // Channels this run could not reach with any candidate token: collected and
    // surfaced as one aggregated warn (ADR-0011 / ADR-0042 決定 5).
    const unreachable: { channel: string; code: string }[] = [];
    let ingestedChannels = 0;
    let tokenWideError: unknown;

    for (const channel of channels) {
      // The reachability map is advisory ORDERING, never a hard filter: a token
      // can hold `channels:history` without the listing scopes (its sweep then
      // reads empty), and the API — not the sweep — is the truth about whether a
      // fetch works. Known-members first, unknown-sweep tokens next; if no token
      // claims or might claim the channel, still try the pool front (the
      // bounded attempts absorb the cost and `not_in_channel` gives the honest
      // per-channel verdict, ADR-0011).
      const live = identities.filter((id) => !id.failed);
      const known = live.filter((id) => reach.get(id)?.has(channel));
      const unknown = live.filter((id) => (reach.get(id) ?? null) === null);
      const ordered = [...known, ...unknown];
      const candidates = ordered.length > 0 ? ordered : live;
      // Bounded failover (ADR-0042 決定 3): the picked token plus at most one more.
      const attempts = candidates.slice(0, 2);

      // Cold-start floor (ADR-0016 / #57): a per-channel `since` override wins
      // over the connector `since`, combined with the legacy bare-ts floor.
      // Applied only to channels with no saved cursor.
      const sinceStr = cfg.channel_since?.[channel] ?? cfg.since;
      const sinceFloor = sinceStr ? (parseSinceToTs(sinceStr, nowMs) ?? undefined) : undefined;
      const floor = higherTs(sinceFloor, legacyFloor ?? undefined);
      const oldest = prevChannels[channel] ?? floor;
      // Per-thread high-water marks carried over from the previous cursor
      // (ADR-0015 R1): `<channel>#<thread_ts>` keys beside the plain key.
      const savedThreadCursors = new Map<string, string>();
      for (const [key, ts] of Object.entries(prevChannels)) {
        const parsed = parseThreadCursorKey(key);
        if (parsed && parsed.channel === channel) savedThreadCursors.set(parsed.threadTs, ts);
      }

      let done = false;
      let lastCode: string | null = null;
      for (const id of attempts) {
        const threadOut = new Map<string, string>();
        try {
          for await (const item of fetchChannelItems(
            id.client,
            channel,
            oldest,
            savedThreadCursors,
            nowMs,
            threadOut,
          )) {
            // History messages and thread replies advance the same per-channel
            // cursor — the highest ts seen resumes next run. A failover retry
            // may re-yield items already yielded by the failed attempt; the
            // canonical externalId (ADR-0042) makes that an unchanged skip at
            // the store, not a duplicate.
            const seen = this.cursors[channel];
            if (seen === undefined || Number.parseFloat(item.ts) > Number.parseFloat(seen)) {
              this.cursors[channel] = item.ts;
            }
            // Resolve author / channel / team names at sync time (ADR-0037);
            // best-effort — a failed resolution degrades to ids, never blocks.
            const userName = item.user
              ? await resolveUserName(id.token, item.user, this.usersTransport, nameCache)
              : null;
            const channelInfo = await resolveChannel(
              id.client,
              id.token,
              channel,
              id.userId ?? cfg.self_user_ids?.[0],
              this.usersTransport,
              nameCache,
              channelCache,
            );
            const teamName = id.teamId
              ? await resolveTeamName(id.client, id.teamId, teamCache)
              : null;
            yield toRecord(id.teamId, channel, item, userName, channelInfo, teamName);
          }
          // Persist the surviving per-thread high-water marks (ADR-0015 R1).
          for (const [threadTs, hwm] of threadOut) {
            this.cursors[threadCursorKey(channel, threadTs)] = hwm;
          }
          done = true;
          break;
        } catch (error) {
          const code = unreachableChannelCode(error);
          if (code !== null) {
            // Channel-scoped (not_in_channel etc.): this token cannot read the
            // channel — fail over to the next candidate.
            lastCode = code;
            continue;
          }
          // Token-wide (auth / rate limit / network): mark the token failed so
          // later channels stop picking it, and fail over for this channel.
          id.failed = true;
          tokenWideError = error;
          const message = error instanceof Error ? error.message : String(error);
          ctx.onWarn?.(`token ${tokenLabel(id)} failed mid-sync: ${message} (cursor preserved)`);
        }
      }

      if (done) {
        ingestedChannels += 1;
        // Preserve the floor for a channel with no new messages so it is not
        // re-scanned from scratch on the next run.
        if (this.cursors[channel] === undefined && oldest !== undefined) {
          this.cursors[channel] = oldest;
        }
      } else {
        if (attempts.length === 0 || lastCode !== null) {
          unreachable.push({ channel, code: lastCode ?? "no reachable token" });
        }
        this.failedChannelCount += 1;
        // Preserve the channel's prior cursor AND its per-thread marks so a
        // transient failure is not a reset (ADR-0015 R1).
        for (const [key, ts] of Object.entries(prevChannels)) {
          const parsed = parseThreadCursorKey(key);
          const ch = parsed ? parsed.channel : key;
          if (ch === channel) this.cursors[key] = ts;
        }
      }
    }

    // One aggregated warn naming every unreachable channel (which, and why), so
    // the operator sees the coverage gap instead of a silent empty sync. The
    // recovery is "add / fix a token for the right workspace" (決定 5) — distinct
    // from a dead token's "replace it".
    if (unreachable.length > 0) {
      const detail = unreachable.map((u) => `${u.channel} (${u.code})`).join(", ");
      ctx.onWarn?.(
        `${unreachable.length} channel(s) unreachable — ${detail}; no configured token can ` +
          "read them — join/invite the bot there, or add that workspace's token " +
          "(`suasor slack auth set`)",
      );
    }

    // Mirror configured Slack Lists as `slack_list_item` sources (ADR-0036 §6
    // read-back) via whichever pool token can reach each list. Raw cells only —
    // `reconcileReadback` interprets them with the [tasks.homes.slack] column
    // config. Best-effort: a per-list failure warns, not aborts.
    yield* this.syncLists(ctx, identities, lists);

    // Record per-token outcomes for the summary (pool order, after the run so
    // mid-sync failures are reflected).
    for (const id of identities) {
      this.tokenStatus.push({ label: tokenLabel(id), status: id.failed ? "failed" : "ok" });
    }

    // Every channel failed on token-wide errors (nothing was merely unreachable
    // and nothing ingested) → surface the error rather than a silent success.
    if (
      channels.length > 0 &&
      ingestedChannels === 0 &&
      unreachable.length === 0 &&
      this.failedChannelCount > 0
    ) {
      throw tokenWideError instanceof Error ? tokenWideError : new Error(String(tokenWideError));
    }
  }

  /**
   * Discovery-drift sweep (ADR-0039 Layer 2), pool-wide (ADR-0042). Enumerates
   * the public + private conversations each live token can see and diffs the
   * union against the configured `channels`: any **member** conversation not in
   * config is drift. Emits one aggregated warn pointing at
   * `slack conversations --new` and returns the marker `"<epochMs>:<newCount>"`.
   * It **never ingests** and never advances a channel cursor.
   *
   * Guards, cheapest first: the per-run override (`ctx.discover`), the
   * `discover_new = false` opt-out, the empty-`channels` guard (a lists-only
   * config would read every visible channel as "new"), and the 24h cadence.
   * Best-effort: a token whose sweep fails is skipped; if every token fails the
   * prior marker is kept (so a hiccup never fails the ingest that follows).
   */
  private async sweepDiscovery(
    ctx: SyncContext,
    identities: readonly TokenIdentity[],
    prevMarker: string | undefined,
  ): Promise<string | undefined> {
    const override = ctx.discover;
    if (override === "skip") return prevMarker;
    if (!(this.config.discover_new ?? true) && override !== "force") return prevMarker;
    if (this.config.channels.length === 0) return prevMarker;

    const nowMs = this.now();
    const prev = prevMarker ? parseDiscoveryMarkerValue(prevMarker) : null;
    if (override !== "force" && prev && nowMs - prev.lastSweptMs < DISCOVERY_SWEEP_INTERVAL_MS)
      return prevMarker;

    const added = new Set<string>();
    let succeeded = 0;
    for (const id of identities) {
      try {
        const { conversations } = await listConversations(id.token, {
          types: DISCOVERY_SWEEP_TYPES,
          ...(this.conversationsTransport ? { transport: this.conversationsTransport } : {}),
        });
        const diff = diffConversations({
          visible: conversations,
          configured: this.config.channels,
          sweptTypes: DISCOVERY_SWEEP_TYPES,
        });
        for (const c of diff.added) added.add(c.id);
        succeeded += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.onWarn?.(`discovery sweep skipped for token ${tokenLabel(id)}: ${message}`);
      }
    }
    if (succeeded === 0) return prevMarker;
    if (added.size > 0) {
      ctx.onWarn?.(
        `${added.size} new conversation(s) visible but not in config — ` +
          "run `suasor slack conversations --new` to review " +
          "(none ingested; cursor unchanged, ADR-0039)",
      );
    }
    return `${nowMs}:${added.size}`;
  }

  /**
   * Ingest the configured Slack Lists' items as `slack_list_item` sources (raw
   * cells, ADR-0036 §6) via whichever pool token can reach each list (first
   * token + one failover, mirroring the channel policy). Paginated; per-list
   * errors warn (best-effort) rather than aborting the sync.
   */
  private async *syncLists(
    ctx: SyncContext,
    identities: readonly TokenIdentity[],
    lists: readonly string[],
  ): AsyncIterable<SourceRecord> {
    if (lists.length === 0) return;
    const observedAt = new Date().toISOString();
    for (const listId of lists) {
      const attempts = identities.filter((id) => !id.failed && id.client.slackListsItems);
      if (attempts.length === 0) continue; // fakes without list support
      let lastError: unknown;
      let done = false;
      for (const id of attempts.slice(0, 2)) {
        const listFn = id.client.slackListsItems;
        if (!listFn) continue;
        try {
          let cursor: string | undefined;
          do {
            const res = await listFn({
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
          done = true;
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!done) {
        ctx.onWarn?.(
          `slack list '${listId}' failed: ${
            lastError instanceof Error ? lastError.message : String(lastError)
          }`,
        );
      }
    }
  }

  finalize(): SyncResult {
    const cursor = serializeCursor(this.cursors);
    // Nothing ran (e.g. an empty/no-channel config): minimal result, no summary.
    if (this.tokenStatus.length === 0) return { cursor };

    // One summary line naming each token's outcome (ADR-0042 決定 5), e.g.
    // `tokens: T0ACME "Acme"=ok, #2=dead (replace it), T0BETA=failed (cursor
    // preserved)`. Emitted only when there is something to tell apart (2+ tokens
    // or any non-ok), so the common single-healthy-token run stays terse.
    const anyNotOk = this.tokenStatus.some((t) => t.status !== "ok");
    const summaryLines: string[] = [];
    if (this.tokenStatus.length > 1 || anyNotOk) {
      const parts = this.tokenStatus.map((t) => {
        if (t.status === "dead") return `${t.label}=dead (replace it)`;
        if (t.status === "failed") return `${t.label}=failed (cursor preserved)`;
        return `${t.label}=ok`;
      });
      summaryLines.push(`tokens: ${parts.join(", ")}`);
    }

    // Partial failure (ADR-0027 / #166): some token died / failed mid-run, or
    // some channel could not be ingested, while the run as a whole proceeded (a
    // total failure already threw). Exits 1 so cron / CI sees the gap.
    const partialFailure = anyNotOk || this.failedChannelCount > 0;

    return {
      cursor,
      ...(partialFailure ? { partialFailure } : {}),
      ...(summaryLines.length > 0 ? { summaryLines } : {}),
    };
  }
}

/**
 * Stream a channel's messages and its threads' replies (ADR-0015, R1).
 *
 * Two passes over `conversations.replies` (both on the SDK `WebClient`, so they
 * inherit its Retry-After-honoured rate-limit retry — ADR-0019 §3 keeps the sync
 * hot path on the SDK rather than the fetch-layer `slackFetch`):
 *
 * 1. **In-window parents.** `conversations.history` pages; for every thread
 *    parent (`reply_count > 0`) in the window, its replies are interleaved right
 *    after the parent. Only parents with replies are expanded (N+1 guard).
 * 2. **Steady-state re-poll.** Every *active* thread carried in
 *    `savedThreadCursors` whose parent did NOT surface in this history window —
 *    the channel cursor has moved past it, the normal cron case — is re-polled
 *    from its own high-water mark, so a new reply to an older thread is still
 *    captured. Inactive threads (no reply within {@link ACTIVE_THREAD_WINDOW_MS})
 *    are pruned: not re-polled and dropped from `out`, bounding the added calls
 *    to live threads.
 *
 * The surviving per-thread high-water marks (last captured reply ts) are written
 * into `out`, keyed by `thread_ts`; the caller persists them as
 * `<channel>#<thread_ts>` cursor entries.
 */
async function* fetchChannelItems(
  client: SlackClientLike,
  channel: string,
  oldest: string | undefined,
  savedThreadCursors: ReadonlyMap<string, string>,
  nowMs: number,
  out: Map<string, string>,
): AsyncIterable<SlackMessageItem> {
  const handled = new Set<string>();
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
        const threadTs = item.ts;
        handled.add(threadTs);
        const savedHwm = savedThreadCursors.get(threadTs);
        // Fetch replies newer than the higher of the channel oldest and any
        // saved thread mark, so already-captured replies are never re-fetched.
        const replyOldest = higherTs(oldest, savedHwm);
        let hwm = higherTs(savedHwm, threadTs) ?? threadTs;
        for await (const reply of fetchThreadReplies(client, channel, threadTs, replyOldest)) {
          yield reply;
          hwm = maxTs(hwm, reply.ts);
        }
        // Only track a thread that is still active, so cold-start-old threads
        // don't linger in the cursor to be pruned one run later.
        if (isThreadActive(hwm, nowMs)) out.set(threadTs, hwm);
      }
    }
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);

  // Pass 2: re-poll active threads whose parent did not appear above.
  for (const [threadTs, savedHwm] of savedThreadCursors) {
    if (handled.has(threadTs)) continue; // already re-fetched inline this run
    if (!isThreadActive(savedHwm, nowMs)) continue; // prune: drop the cursor, no call
    let hwm = savedHwm;
    for await (const reply of fetchThreadReplies(client, channel, threadTs, savedHwm)) {
      yield reply;
      hwm = maxTs(hwm, reply.ts);
    }
    out.set(threadTs, hwm);
  }
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
  // Fail fast on the removed ADR-0014 multi-workspace shape (ADR-0042 決定 9:
  // no silent conversion — the error carries the mechanical migration).
  rejectLegacySlackConfig(config);
  const parsed = SlackConnectorConfig.parse(config ?? {});
  // Fail fast on an unparseable `since` / `channel_since` floor rather than
  // letting it silently degrade to "no floor" mid-sync (ADR-0007, Issue #157).
  validateSlackSince(parsed);
  return new SlackConnector(
    parsed,
    options.clientFactory ?? defaultSlackClientFactory,
    options.now,
    options.usersTransport ?? defaultUsersTransport,
    options.conversationsTransport,
  );
}

/**
 * Platform manifest (SSOT for the scattered per-connector tables, Issue #440).
 * Slack is folded into the same manifest shape via capability flags: it maintains
 * its own richer auth (`slack auth set/test`, ADR-0011) and discovery
 * (`slack conversations`, ADR-0011/0013/0014) flows, so it opts out of the
 * generic `AUTH_SPECS` / `DISCOVERY_SPECS` surfaces (documented in
 * `capabilityNotes`) instead of being an invisible special case. It is the only
 * connector that surfaces channels / teams (ADR-0037).
 */
export const manifest: ConnectorManifest = {
  name: SLACK_CONNECTOR_NAME,
  sourceType: "slack",
  configSchema: SlackConnectorConfig,
  // The single unnamed token pool (ADR-0042): keychain `connector:slack:tokens`,
  // env SUASOR_CONNECTOR_SLACK_TOKENS (newline/comma separated, replace-all).
  secretNames: [SLACK_TOKENS_SECRET],
  needsAuth: true,
  bundledInBinary: false,
  sliceTemplate: {
    body: ["enabled = true", "# channels = []            # channel IDs to ingest (empty = none)"],
  },
  noopWarning(slice) {
    const cfg = SlackConnectorConfig.parse(slice ?? {});
    // A target exists when `channels` (or `lists`) is non-empty (ADR-0042 flat shape).
    if (cfg.channels.length === 0 && (cfg.lists ?? []).length === 0) {
      return "channels unset — nothing to ingest (set channels in config — get ids with `suasor slack conversations`)";
    }
    return null;
  },
  // Slack keeps its own pool auth + scope-readiness flows (ADR-0011/0042),
  // so it is deliberately absent from the generic AUTH_SPECS / DISCOVERY_SPECS.
  genericAuth: false,
  genericDiscovery: false,
  // `suasor onboard` drives slack through its dedicated bridge (#458; the
  // behaviour lives in src/cli/onboard/slack-bridge.ts).
  connectorSpecificOnboard: true,
  surfacesChannels: true,
  surfacesTeams: true,
  capabilityNotes: {
    genericAuth: "own token-pool auth + scope readiness (`slack auth set/test`, ADR-0011/0042)",
    genericDiscovery:
      "own richer discovery with join marks / engagement sort (`slack conversations`, ADR-0011/0013/0042)",
  },
};
