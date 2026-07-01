/**
 * Team-observation extraction from a source record's connector metadata
 * (ADR-0037 §3/§10 / Issue #361, ADR-0007). The sync service uses this to emit
 * `SlackTeamObserved` so the `slack_teams` projection can join a team id to a
 * human-readable workspace name at display time without a live fetch
 * (no-fetch-at-query, ADR-0012).
 *
 * Sibling of `channel.ts` / `author.ts`: each connector stashes the sync-time-
 * resolved team name under its own `meta` keys, and this module is the single
 * place mapping a connector name to those keys — so the reducer/sync stay
 * decoupled from per-connector meta shapes. A connector with no team concept (or
 * a record missing the id) yields `null` and no team is recorded (best-effort,
 * never throws).
 *
 * Import-clean: plain data + a pure function; pulls no connector SDK.
 */

/** The `meta` keys a connector stores its team id / name under. */
interface TeamMetaKeys {
  /** Key holding the team / workspace id (`T…`). */
  id: string;
  /** Key holding the sync-time-resolved team name (may be absent on degrade). */
  name: string;
}

/**
 * Per-connector team meta keys (ADR-0037 §3/§10). Only Slack surfaces teams;
 * `team` is already on every `slack_message` record, and the sync-time resolver
 * adds `teamName`.
 */
const TEAM_META_KEYS: Record<string, TeamMetaKeys> = {
  slack: { id: "team", name: "teamName" },
};

/** One observed team derived from a record's meta (the `SlackTeamObserved` payload). */
export interface ObservedTeam {
  teamId: string;
  /** Resolved name; absent when unresolved (degrade → id fallback at display, §6). */
  displayName?: string;
}

/**
 * Extract the observed team for a record of `connector`, reading the id (and
 * optional resolved name) out of `meta`. Returns `null` when the connector has no
 * team mapping, or the id is missing / invalid — so callers simply skip recording
 * a team (best-effort). A blank / missing / non-string team name leaves
 * `displayName` unset, which the reducer treats as "unresolved" (keeps a prior
 * non-empty name, ADR-0037 §6/§7).
 */
export function teamFromMeta(
  connector: string,
  meta: Record<string, unknown>,
): ObservedTeam | null {
  const keys = TEAM_META_KEYS[connector];
  if (keys === undefined) return null;

  const rawId = meta[keys.id];
  if (typeof rawId !== "string" || rawId.trim() === "") return null;

  const team: ObservedTeam = { teamId: rawId.trim() };
  const rawName = meta[keys.name];
  if (typeof rawName === "string" && rawName.trim() !== "") team.displayName = rawName.trim();
  return team;
}
