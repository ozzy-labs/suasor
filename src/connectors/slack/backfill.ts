/**
 * Slack name backfill (ADR-0037 §11/§12).
 *
 * Forward sync only enriches names for messages it newly ingests: a source that
 * was ingested before name resolution existed keeps its `C…`/`U…` id-only. This
 * module walks the **already-ingested** `slack_message` sources, collects the
 * distinct channel / user ids, and re-resolves the ones whose name is still
 * missing — appending `SlackChannelObserved` / `PersonIdentityObserved` so the
 * `slack_channels` + person projections are enriched last-write-wins, exactly
 * like the sync path (SSOT: same resolvers, same events).
 *
 * Design guarantees carried over from sync:
 * - **reuse, don't reimplement** — channel names go through `resolveChannel`
 *   (`conversations.info`/`members`) and user names through `resolveUserName`
 *   (`users.info`), the same functions sync wires in.
 * - **token pool (ADR-0042)** — each id is resolved via the pool token whose
 *   `auth.test` team matches the source's `meta.team` when one does, else the
 *   first pool token, with one bounded failover to another token when the
 *   resolution comes back empty (mirroring sync's channel policy).
 * - **idempotent (§7)** — an id that already has a resolved (non-empty) name is
 *   skipped; `--force` re-resolves it (last-write-wins keeps it harmless).
 * - **degrade (§6/§7)** — a scope-less / API-erroring id resolves to an empty
 *   name and is *counted* but never throws, so one bad id can't abort the run.
 * - **network-injectable** — the Slack client + `users.info` transport + token
 *   resolver are all injected, so tests drive the whole path with fakes (no net).
 */

import type { Store } from "../../db/index.ts";
import { identityKey, personIdFor } from "../../projections/person.ts";
import {
  parseTokenPool,
  SLACK_TOKENS_SECRET,
  type SlackClientFactory,
  type SlackConnectorConfig,
} from "../slack.ts";
import { type ResolvedChannel, resolveChannel } from "./channel.ts";
import { resolveUserName, type SlackUsersTransport } from "./resolve.ts";
import { resolveTeamName } from "./team.ts";

/** Injected side-effecting dependencies, so the whole path is network-free in tests. */
export interface BackfillDeps {
  /** Build a Slack client for a pool token (channel `conversations.info`/`members`). */
  clientFactory: SlackClientFactory;
  /** `users.info` transport for user / DM-participant name resolution (ADR-0037 §2). */
  usersTransport: SlackUsersTransport;
  /** Resolve the pool secret by name (`makeSecretResolver` in the CLI). */
  secret: (secretName: string) => Promise<string | null>;
  /** Clock for the appended events; injectable for deterministic tests. */
  now?: () => Date;
}

/** Options narrowing / tuning a backfill pass. */
export interface BackfillOptions {
  /** Re-resolve ids that already carry a resolved name (default: skip them, §7). */
  force?: boolean;
  /** Fired once per id actually resolved (drives the CLI progress indicator). */
  onProgress?: () => void;
}

/** Resolution tallies for one id kind (channels or users). */
export interface NameCounts {
  /** Ids that resolved to a non-empty human name this run. */
  resolved: number;
  /** Ids skipped because they already had a resolved name (idempotent, §7). */
  skipped: number;
  /** Ids attempted but resolved empty (missing scope / API error → id fallback, §6). */
  degraded: number;
}

/** Outcome of a backfill pass, used to build the CLI summary. */
export interface BackfillSummary {
  channels: NameCounts;
  users: NameCounts;
  /** Team ids re-resolved to workspace names (ADR-0037 §10, Issue #361). */
  teams: NameCounts;
}

/** One `{ team, id }` row extracted from a `slack_message` source's meta. */
interface MetaIdRow {
  team: string | null;
  id: string | null;
}

/** Distinct `(team, id)` pairs for a given `meta` key across `slack_message` sources. */
function distinctByTeam(store: Store, metaKey: "channel" | "user"): MetaIdRow[] {
  return store.connection.sqlite
    .query(
      `SELECT DISTINCT json_extract(meta, '$.team') AS team,
                       json_extract(meta, '$.${metaKey}') AS id
         FROM sources
        WHERE source_type = 'slack_message'
          AND json_extract(meta, '$.${metaKey}') IS NOT NULL
          AND json_extract(meta, '$.${metaKey}') <> ''`,
    )
    .all() as MetaIdRow[];
}

/** Whether a channel already carries a resolved (non-empty) name in the projection. */
function channelHasName(store: Store, channelId: string): boolean {
  return (
    store.connection.sqlite
      .query("SELECT 1 FROM slack_channels WHERE channel_id = ? AND name <> '' LIMIT 1")
      .get(channelId) !== null
  );
}

/** Whether a Slack user's person identity already carries a resolved display name. */
function userHasName(store: Store, handle: string): boolean {
  return (
    store.connection.sqlite
      .query(
        "SELECT 1 FROM person_identities WHERE identity_key = ? AND display_name <> '' LIMIT 1",
      )
      .get(identityKey("slack", handle)) !== null
  );
}

/** Whether a Slack team already carries a resolved (non-empty) name in the projection. */
function teamHasName(store: Store, teamId: string): boolean {
  return (
    store.connection.sqlite
      .query("SELECT 1 FROM slack_teams WHERE team_id = ? AND name <> '' LIMIT 1")
      .get(teamId) !== null
  );
}

/** One pool token prepared for resolution: client + per-token caches + identity. */
interface ResolverToken {
  token: string;
  client: Awaited<ReturnType<SlackClientFactory>>;
  teamId: string | undefined;
  userCache: Map<string, string | null>;
  channelCache: Map<string, ResolvedChannel>;
  teamCache: Map<string, string | null>;
}

/**
 * The resolver tokens to try for an id whose source carries `team`: the token
 * whose own team matches first (its scopes are the likeliest fit), then one
 * other token as bounded failover (ADR-0042 決定 3 mirrored). Ids with no /
 * unknown team just try the pool front.
 */
function resolversFor(tokens: ResolverToken[], team: string | null): ResolverToken[] {
  const matched = team === null ? undefined : tokens.find((t) => t.teamId === team);
  const rest = tokens.filter((t) => t !== matched);
  const ordered = matched ? [matched, ...rest] : rest;
  return ordered.slice(0, 2);
}

/**
 * Re-resolve missing Slack channel / user names for already-ingested sources
 * (ADR-0037 §11). Appends `SlackChannelObserved` / `PersonIdentityObserved` for
 * each unresolved id (best-effort, degrading empty on scope/API failure) and
 * returns per-kind tallies. Purely additive to the event log — safe to re-run.
 */
export async function backfillSlackNames(
  store: Store,
  _config: SlackConnectorConfig,
  deps: BackfillDeps,
  options: BackfillOptions = {},
): Promise<BackfillSummary> {
  const now = deps.now ?? (() => new Date());
  const summary: BackfillSummary = {
    channels: { resolved: 0, skipped: 0, degraded: 0 },
    users: { resolved: 0, skipped: 0, degraded: 0 },
    teams: { resolved: 0, skipped: 0, degraded: 0 },
  };

  const channelRows = distinctByTeam(store, "channel");
  const userRows = distinctByTeam(store, "user");
  // Nothing ingested → nothing to resolve; an all-zero summary needs no token.
  if (channelRows.length === 0 && userRows.length === 0) return summary;

  const pool = parseTokenPool(await deps.secret(SLACK_TOKENS_SECRET));
  if (pool.length === 0) {
    throw new Error(
      "no Slack token pool configured " +
        "(set SUASOR_CONNECTOR_SLACK_TOKENS or run `suasor slack auth set`)",
    );
  }

  // Prepare each pool token: client + its own per-run caches (ids resolved via
  // one token never cross-resolve through another's cache) + its auth.test team
  // id, so a source's `meta.team` prefers the matching token.
  const tokens: ResolverToken[] = [];
  for (const token of pool) {
    const client = await deps.clientFactory(token);
    let teamId: string | undefined;
    if (client.authTest) {
      try {
        const res = await client.authTest();
        if (res.ok !== false && res.team_id) teamId = res.team_id;
      } catch {
        // Best-effort: an undescribable token still participates unmatched.
      }
    }
    tokens.push({
      token,
      client,
      teamId,
      userCache: new Map(),
      channelCache: new Map(),
      teamCache: new Map(),
    });
  }

  // Team names (ADR-0037 §10): every distinct team the sources reference, plus
  // each token's own team. Grid enumeration inside `resolveTeamName` can name
  // foreign teams too, so the failover order still applies.
  const teamIds = new Set<string>();
  for (const t of tokens) if (t.teamId) teamIds.add(t.teamId);
  for (const row of [...channelRows, ...userRows]) if (row.team) teamIds.add(row.team);
  for (const teamId of teamIds) {
    if (!options.force && teamHasName(store, teamId)) {
      summary.teams.skipped += 1;
      continue;
    }
    options.onProgress?.();
    let teamName: string | null = null;
    for (const t of resolversFor(tokens, teamId)) {
      teamName = await resolveTeamName(t.client, teamId, t.teamCache);
      if (teamName) break;
    }
    store.record(
      {
        type: "SlackTeamObserved",
        teamId,
        ...(teamName ? { displayName: teamName } : {}),
      },
      now(),
    );
    if (teamName) summary.teams.resolved += 1;
    else summary.teams.degraded += 1;
  }

  // Channel names. Distinct ids (a channel may appear under several teams in
  // legacy team-prefixed sources); first (team, id) row wins the token order.
  const seenChannels = new Set<string>();
  for (const { team, id: channelId } of channelRows) {
    if (!channelId || seenChannels.has(channelId)) continue;
    seenChannels.add(channelId);
    if (!options.force && channelHasName(store, channelId)) {
      summary.channels.skipped += 1;
      continue;
    }
    options.onProgress?.();
    let info: ResolvedChannel | null = null;
    for (const t of resolversFor(tokens, team)) {
      info = await resolveChannel(
        t.client,
        t.token,
        channelId,
        undefined,
        deps.usersTransport,
        t.userCache,
        t.channelCache,
      );
      if (info.name) break;
    }
    // Always emit: a non-empty name enriches the projection, an empty one still
    // records the id + kind (id fallback at display, §6). last-write-wins keeps
    // a prior resolved name from being blanked by a degrade (reducer guard).
    const resolved = info as ResolvedChannel;
    store.record(
      {
        type: "SlackChannelObserved",
        channelId,
        ...(team ? { teamId: team } : {}),
        kind: resolved.kind,
        ...(resolved.name ? { displayName: resolved.name } : {}),
      },
      now(),
    );
    if (resolved.name) summary.channels.resolved += 1;
    else summary.channels.degraded += 1;
  }

  // User names.
  const seenUsers = new Set<string>();
  for (const { team, id: userId } of userRows) {
    if (!userId || seenUsers.has(userId)) continue;
    seenUsers.add(userId);
    if (!options.force && userHasName(store, userId)) {
      summary.users.skipped += 1;
      continue;
    }
    options.onProgress?.();
    let name: string | null = null;
    for (const t of resolversFor(tokens, team)) {
      name = await resolveUserName(t.token, userId, deps.usersTransport, t.userCache);
      if (name) break;
    }
    store.record(
      {
        type: "PersonIdentityObserved",
        personId: personIdFor("slack", userId),
        connector: "slack",
        handle: userId,
        ...(name ? { displayName: name } : {}),
      },
      now(),
    );
    if (name) summary.users.resolved += 1;
    else summary.users.degraded += 1;
  }

  return summary;
}
