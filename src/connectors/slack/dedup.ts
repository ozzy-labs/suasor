/**
 * Shared-channel de-duplication (ADR-0038 Layer 1).
 *
 * Enterprise Grid shares one channel — one globally-unique channel id (`C…`) —
 * across multiple workspaces. Under multi-workspace ingest (ADR-0014) each alias
 * would ingest the same message as a separate `slack:<team>:<channel>:<ts>`
 * source, double-counting it in `slack.demand.list` / `search` / `brief`. This
 * module computes a deterministic single **owner** alias per channel id so sync
 * ingests each shared channel exactly once (owner-wins, non-destructive: the
 * externalId format is unchanged, so single-workspace / non-shared channels are
 * unaffected).
 *
 * Owner selection is the **lexicographically smallest alias** among the aliases
 * that list the channel (ADR-0038 §2), compared by UTF-16 code unit (plain `<`,
 * locale-independent so it is deterministic across environments). This does not
 * depend on TOML parse / declaration order (`Bun.TOML.parse` gives no table-order
 * guarantee), so the owner is stable across re-syncs and the externalId owner
 * prefix never drifts (which would orphan the old source and re-ingest).
 *
 * NOTE: the de-dup key is the *global* Slack channel id, assumed unique within a
 * single Enterprise Grid. Slack Connect (cross-org shared channels) can break
 * that assumption and is out of scope (ADR-0038 §6).
 *
 * Scope: messages only (team-prefixed externalId). Slack Lists use a
 * team-independent externalId (`slack:list:<id>:item:<id>`) and already collapse
 * naturally, so they need no de-dup (ADR-0038 §5).
 *
 * Reused by PR2 (discovery marking) and PR3 (config / doctor validation) via the
 * same owner rule, so keep the signatures stable and generic.
 */

/** One workspace's channel listing: an alias and the channel ids it ingests. */
export interface WorkspaceChannelListing {
  alias: string;
  channels: string[];
}

/** A channel listed by more than one alias, with its chosen owner (ADR-0038 §2). */
export interface SharedChannel {
  /** Global Slack channel id shared across the aliases. */
  channel: string;
  /** Every alias that lists the channel, ascending (lexicographic, stable). */
  aliases: string[];
  /** The owner alias (lexicographically smallest of {@link aliases}). */
  owner: string;
}

/** Owner assignment for every configured channel id (ADR-0038 §2). */
export interface ChannelOwnership {
  /**
   * channel id → owner alias. Contains **every** channel across all aliases (a
   * non-shared channel maps to its sole alias), so a caller can decide "ingest
   * this channel under this alias?" with a single `owner.get(ch) === alias`.
   */
  owner: Map<string, string>;
  /**
   * Only the channels listed by ≥2 aliases, for an aggregated warn. Ascending by
   * channel id; each entry's `aliases` are ascending too (stable output).
   */
  shared: SharedChannel[];
}

/**
 * Compute the deterministic owner alias for every channel across the given
 * workspaces (ADR-0038 §2). Owner = the lexicographically smallest alias that
 * lists the channel; the result does not depend on the order of `workspaces` nor
 * of each alias's `channels`. A channel listed by a single alias is owned by that
 * alias (and is absent from `shared`).
 */
export function channelOwnership(workspaces: WorkspaceChannelListing[]): ChannelOwnership {
  // channel id → set of aliases that list it (a set so a repeated id within one
  // alias's `channels` counts that alias once, not as a self-"share").
  const aliasesByChannel = new Map<string, Set<string>>();
  for (const ws of workspaces) {
    for (const channel of ws.channels) {
      let set = aliasesByChannel.get(channel);
      if (!set) {
        set = new Set<string>();
        aliasesByChannel.set(channel, set);
      }
      set.add(ws.alias);
    }
  }

  const owner = new Map<string, string>();
  const shared: SharedChannel[] = [];
  for (const [channel, aliasSet] of aliasesByChannel) {
    const aliases = [...aliasSet].sort(); // code-unit order → deterministic
    const ownerAlias = aliases[0] as string; // smallest alias wins (ADR-0038 §2)
    owner.set(channel, ownerAlias);
    if (aliases.length > 1) shared.push({ channel, aliases, owner: ownerAlias });
  }
  // Stable, id-ascending output so the aggregated warn reads deterministically.
  shared.sort((a, b) => (a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : 0));
  return { owner, shared };
}

/**
 * Convenience over {@link channelOwnership}: just the channel id → owner alias
 * map. PR2/PR3 (discovery marking, config / doctor validation) reuse this to
 * mark / warn about shared channels with the same owner rule as sync.
 */
export function ownerAliasForChannels(workspaces: WorkspaceChannelListing[]): Map<string, string> {
  return channelOwnership(workspaces).owner;
}

/**
 * One-line aggregated warn for the shared channels found in a sync pass
 * (ADR-0038 §2). Names each shared channel, the aliases sharing it, and the
 * owner under which it is ingested. Empty input yields an empty string (the
 * caller should skip the warn when there is nothing shared).
 */
export function formatSharedChannelWarn(shared: SharedChannel[]): string {
  if (shared.length === 0) return "";
  const detail = shared
    .map(
      (s) => `${s.channel} shared across [${s.aliases.join(", ")}] → ingesting under '${s.owner}'`,
    )
    .join("; ");
  return `shared channel(s) de-duplicated (same global channel id, ADR-0038): ${detail}`;
}
