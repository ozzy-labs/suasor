/**
 * Slack name backfill (ADR-0037 §11/§12).
 *
 * Forward sync only enriches names for messages it newly ingests: a source that
 * was ingested before name resolution existed keeps its `C…`/`U…` id-only. This
 * module walks the **already-ingested** `slack_message` sources, collects the
 * distinct channel / user ids per workspace, and re-resolves the ones whose name
 * is still missing — appending `SlackChannelObserved` / `PersonIdentityObserved`
 * so the `slack_channels` + person projections are enriched last-write-wins,
 * exactly like the sync path (SSOT: same resolvers, same events).
 *
 * Design guarantees carried over from sync:
 * - **reuse, don't reimplement** — channel names go through `resolveChannel`
 *   (`conversations.info`/`members`) and user names through `resolveUserName`
 *   (`users.info`), the same functions PR1/PR2 wired into sync.
 * - **multi-workspace (ADR-0014)** — each source's `meta.team` is mapped back to
 *   its configured workspace, and resolution runs with that workspace's own token
 *   / self-user-id, so ids never cross-resolve between workspaces.
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
  type ResolvedWorkspace,
  resolveWorkspaces,
  type SlackClientFactory,
  type SlackConnectorConfig,
} from "../slack.ts";
import { type ResolvedChannel, resolveChannel } from "./channel.ts";
import { resolveUserName, type SlackUsersTransport } from "./resolve.ts";
import { resolveTeamName } from "./team.ts";

/** Injected side-effecting dependencies, so the whole path is network-free in tests. */
export interface BackfillDeps {
  /** Build a Slack client for a workspace token (channel `conversations.info`/`members`). */
  clientFactory: SlackClientFactory;
  /** `users.info` transport for user / DM-participant name resolution (ADR-0037 §2). */
  usersTransport: SlackUsersTransport;
  /** Resolve a workspace token by keychain secret name (`makeSecretResolver` in the CLI). */
  secret: (secretName: string) => Promise<string | null>;
  /** Clock for the appended events; injectable for deterministic tests. */
  now?: () => Date;
}

/** Options narrowing / tuning a backfill pass. */
export interface BackfillOptions {
  /** Limit the pass to one workspace alias (omit for every configured workspace). */
  workspace?: string;
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
  /** In-scope workspace aliases that had no token (skipped entirely, ADR-0014). */
  tokenlessWorkspaces: string[];
  /** Distinct ids whose `meta.team` matches no configured workspace (can't resolve). */
  orphanTeamIds: number;
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

/**
 * Group distinct ids by team into (a) the in-scope workspaces to process and (b)
 * an orphan count for ids whose team matches no configured workspace at all. Ids
 * whose team is a known-but-out-of-scope workspace (when `--workspace` narrows
 * the pass) are silently ignored — neither processed nor counted as orphan.
 */
function groupByTeam(
  rows: MetaIdRow[],
  scopedByTeam: Map<string, ResolvedWorkspace>,
  knownTeams: Set<string>,
): { byTeam: Map<string, Set<string>>; orphans: Set<string> } {
  const byTeam = new Map<string, Set<string>>();
  const orphans = new Set<string>();
  for (const { team, id } of rows) {
    if (!id) continue;
    if (team !== null && scopedByTeam.has(team)) {
      let set = byTeam.get(team);
      if (!set) {
        set = new Set<string>();
        byTeam.set(team, set);
      }
      set.add(id);
    } else if (team === null || !knownTeams.has(team)) {
      // No team, or a team no configured workspace claims → can't pick a token.
      orphans.add(id);
    }
    // else: known team, out of the current --workspace scope → skip quietly.
  }
  return { byTeam, orphans };
}

/**
 * Re-resolve missing Slack channel / user names for already-ingested sources
 * (ADR-0037 §11). Appends `SlackChannelObserved` / `PersonIdentityObserved` for
 * each unresolved id (best-effort, degrading empty on scope/API failure) and
 * returns per-kind tallies. Purely additive to the event log — safe to re-run.
 */
export async function backfillSlackNames(
  store: Store,
  config: SlackConnectorConfig,
  deps: BackfillDeps,
  options: BackfillOptions = {},
): Promise<BackfillSummary> {
  const now = deps.now ?? (() => new Date());
  const summary: BackfillSummary = {
    channels: { resolved: 0, skipped: 0, degraded: 0 },
    users: { resolved: 0, skipped: 0, degraded: 0 },
    teams: { resolved: 0, skipped: 0, degraded: 0 },
    tokenlessWorkspaces: [],
    orphanTeamIds: 0,
  };

  const allWorkspaces = resolveWorkspaces(config);
  const knownTeams = new Set(allWorkspaces.map((w) => w.team));
  const scoped = options.workspace
    ? allWorkspaces.filter((w) => w.alias === options.workspace)
    : allWorkspaces;
  // First workspace wins a shared team id (configs rarely reuse a team across
  // aliases; if they do, one token is enough to resolve that team's ids).
  const scopedByTeam = new Map<string, ResolvedWorkspace>();
  for (const w of scoped) if (!scopedByTeam.has(w.team)) scopedByTeam.set(w.team, w);

  const channelGroups = groupByTeam(distinctByTeam(store, "channel"), scopedByTeam, knownTeams);
  const userGroups = groupByTeam(distinctByTeam(store, "user"), scopedByTeam, knownTeams);
  // Orphan ids of both kinds count once each toward the "couldn't attempt" total.
  summary.orphanTeamIds = channelGroups.orphans.size + userGroups.orphans.size;

  for (const [team, ws] of scopedByTeam) {
    const channelIds = channelGroups.byTeam.get(team);
    const userIds = userGroups.byTeam.get(team);
    if (!channelIds && !userIds) continue; // no ingested ids for this workspace

    const token = await deps.secret(ws.secretName);
    if (!token) {
      // No token → skip the workspace whole rather than fail (ADR-0014 isolation).
      summary.tokenlessWorkspaces.push(ws.alias);
      continue;
    }

    const client = await deps.clientFactory(token);
    // Per-workspace caches (ADR-0037 §5): each id resolves its transport at most
    // once this run; keyed implicitly by this workspace's token, so ids never
    // cross-resolve between workspaces.
    const userCache = new Map<string, string | null>();
    const channelCache = new Map<string, ResolvedChannel>();
    const teamCache = new Map<string, string | null>();

    // Team name (ADR-0037 §10, Issue #361): re-resolve this workspace's team id →
    // workspace name, unless it already carries a resolved name (idempotent, §7;
    // --force re-resolves). Always emit so a degrade still records the id (id
    // fallback at display, §6). last-write-wins keeps a prior name from a degrade.
    if (!options.force && teamHasName(store, team)) {
      summary.teams.skipped += 1;
    } else {
      options.onProgress?.();
      const teamName = await resolveTeamName(client, team, teamCache);
      store.record(
        {
          type: "SlackTeamObserved",
          teamId: team,
          ...(teamName ? { displayName: teamName } : {}),
        },
        now(),
      );
      if (teamName) summary.teams.resolved += 1;
      else summary.teams.degraded += 1;
    }

    for (const channelId of channelIds ?? []) {
      if (!options.force && channelHasName(store, channelId)) {
        summary.channels.skipped += 1;
        continue;
      }
      options.onProgress?.();
      const info = await resolveChannel(
        client,
        token,
        channelId,
        ws.selfUserId,
        deps.usersTransport,
        userCache,
        channelCache,
      );
      // Always emit: a non-empty name enriches the projection, an empty one still
      // records the id + kind (id fallback at display, §6). last-write-wins keeps
      // a prior resolved name from being blanked by a degrade (reducer guard).
      store.record(
        {
          type: "SlackChannelObserved",
          channelId,
          teamId: team,
          kind: info.kind,
          ...(info.name ? { displayName: info.name } : {}),
        },
        now(),
      );
      if (info.name) summary.channels.resolved += 1;
      else summary.channels.degraded += 1;
    }

    for (const userId of userIds ?? []) {
      if (!options.force && userHasName(store, userId)) {
        summary.users.skipped += 1;
        continue;
      }
      options.onProgress?.();
      const name = await resolveUserName(token, userId, deps.usersTransport, userCache);
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
  }

  return summary;
}
