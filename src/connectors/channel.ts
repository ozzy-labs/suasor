/**
 * Channel-observation extraction from a source record's connector metadata
 * (ADR-0037 §3 / ADR-0007). The sync service uses this to emit
 * `SlackChannelObserved` so the `slack_channels` projection can join a
 * conversation id to a human-readable name at display time without a live fetch
 * (no-fetch-at-query, ADR-0012).
 *
 * Sibling of `author.ts`: each connector stashes the sync-time-resolved channel
 * name / kind under its own `meta` keys, and this module is the single place
 * mapping a connector name to those keys — so the reducer/sync stay decoupled
 * from per-connector meta shapes. A connector with no channel concept (or a
 * record missing the id / kind) yields `null` and no channel is recorded
 * (best-effort, never throws).
 *
 * Import-clean: plain data + a pure function; pulls no connector SDK.
 */

import { SLACK_CHANNEL_KINDS, type SlackChannelKind } from "../events/types.ts";

/** The `meta` keys a connector stores its channel id / team / name / kind under. */
interface ChannelMetaKeys {
  /** Key holding the conversation id (`C…/G…/D…`). */
  id: string;
  /** Key holding the team / workspace id. */
  team: string;
  /** Key holding the sync-time-resolved channel name (may be absent on degrade). */
  name: string;
  /** Key holding the channel kind (public / private / group / dm). */
  kind: string;
}

/**
 * Per-connector channel meta keys (ADR-0037 §3). Only Slack surfaces channels;
 * `channel` / `team` are already on every `slack_message` record, and the sync-
 * time resolver adds `channelName` / `channelKind`.
 */
const CHANNEL_META_KEYS: Record<string, ChannelMetaKeys> = {
  slack: { id: "channel", team: "team", name: "channelName", kind: "channelKind" },
};

/** One observed channel derived from a record's meta (the `SlackChannelObserved` payload). */
export interface ObservedChannel {
  channelId: string;
  teamId: string;
  kind: SlackChannelKind;
  /** Resolved name; absent when unresolved (degrade → id fallback at display, §6). */
  displayName?: string;
}

/** Narrow an unknown value to a known Slack channel kind. */
function isChannelKind(value: unknown): value is SlackChannelKind {
  return typeof value === "string" && (SLACK_CHANNEL_KINDS as readonly string[]).includes(value);
}

/**
 * Extract the observed channel for a record of `connector`, reading the id /
 * team / kind (and optional resolved name) out of `meta`. Returns `null` when
 * the connector has no channel mapping, or the id / kind / team is missing or
 * invalid — so callers simply skip recording a channel (best-effort). A blank /
 * missing / non-string `channelName` leaves `displayName` unset, which the
 * reducer treats as "unresolved" (keeps a prior non-empty name, ADR-0037 §6/§7).
 */
export function channelFromMeta(
  connector: string,
  meta: Record<string, unknown>,
): ObservedChannel | null {
  const keys = CHANNEL_META_KEYS[connector];
  if (keys === undefined) return null;

  const rawId = meta[keys.id];
  if (typeof rawId !== "string" || rawId.trim() === "") return null;
  const rawKind = meta[keys.kind];
  if (!isChannelKind(rawKind)) return null;
  const rawTeam = meta[keys.team];
  // teamId is load-bearing (id-prefix scope, ADR-0014) and the event requires it;
  // skip recording a channel that has no team rather than emit an invalid event.
  if (typeof rawTeam !== "string" || rawTeam.trim() === "") return null;

  const channel: ObservedChannel = {
    channelId: rawId.trim(),
    teamId: rawTeam.trim(),
    kind: rawKind,
  };
  const rawName = meta[keys.name];
  if (typeof rawName === "string" && rawName.trim() !== "") channel.displayName = rawName.trim();
  return channel;
}
