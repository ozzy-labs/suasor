/**
 * Slack Enterprise Grid workspace enumeration for `slack conversations` (ADR-0011
 * / Issue #350). Lists the workspaces (teams) a token can reach so the discovery
 * sweep can list channels across the whole grid, not just the token's default
 * workspace.
 *
 * Backed by `auth.teams.list`, which returns **the workspaces an org-wide app
 * has been approved for** — so it is meaningful only for an org-level (org-wide
 * app) token. A workspace-level token, a non-Grid workspace, or a missing scope
 * self-reports as an empty list, and the caller falls back to the single team
 * from `auth.test` (current behaviour). Enumeration never fails the sweep.
 *
 * Import-clean (ADR-0007): no Slack SDK. The default transport goes through the
 * shared rate-limit-aware `slackFetch` (ADR-0019); top-level imports stay light.
 */

import { slackFetch } from "./_fetch.ts";

/** One Enterprise Grid workspace surfaced for discovery. */
export interface SlackTeam {
  /** Workspace (team) id (`T…`). */
  readonly id: string;
  /** Workspace name, or the id when Slack does not report one. */
  readonly name: string;
}

export interface ListTeamsOptions {
  /** Transport override (tests inject a fake; default lazy-`fetch`). */
  readonly transport?: SlackTeamsTransport;
  /**
   * Called once per fetched page so a CLI can render an indeterminate progress
   * counter. Best-effort: any throw is ignored so progress never fails listing.
   */
  readonly onProgress?: () => void;
}

/** One `auth.teams.list` page fetch, decoupled from `fetch` for tests. */
export type SlackTeamsTransport = (
  token: string,
  params: Record<string, string>,
) => Promise<Record<string, unknown>>;

/** Default transport: a rate-limit-aware GET to `auth.teams.list` (ADR-0019). */
const defaultTransport: SlackTeamsTransport = async (token, params) => {
  const query = new URLSearchParams(params).toString();
  const { body } = await slackFetch(`https://slack.com/api/auth.teams.list?${query}`, { token });
  return body;
};

/** Per-page ceiling (Slack's max for this method). */
const PAGE_LIMIT = 100;

interface RawTeam {
  id?: string;
  name?: string;
}

/**
 * Enumerate the Enterprise Grid workspaces a token can reach (Issue #350).
 *
 * Sweeps `auth.teams.list` with cursor pagination. Any non-`ok` response —
 * `missing_scope`, `enterprise_is_restricted` (not callable outside an org),
 * `unknown_method` / method-not-allowed on a plan without Grid, or a rate limit
 * that survived retries — is treated as "cannot enumerate": the partial result
 * so far is returned and the caller falls back to the single team from
 * `auth.test`. Enumeration is best-effort and never throws.
 *
 * @returns the reachable teams (possibly empty when enumeration is unavailable).
 */
export async function listTeams(
  token: string,
  options: ListTeamsOptions = {},
): Promise<SlackTeam[]> {
  const transport = options.transport ?? defaultTransport;
  const tick = () => {
    try {
      options.onProgress?.();
    } catch {}
  };
  const teams: SlackTeam[] = [];
  let cursor: string | undefined;
  do {
    const params: Record<string, string> = { limit: String(PAGE_LIMIT) };
    if (cursor) params.cursor = cursor;

    let body: Record<string, unknown>;
    try {
      body = await transport(token, params);
    } catch {
      // Network/transport failure → cannot enumerate; fall back to single team.
      break;
    }
    tick();
    // Any non-ok (missing_scope / enterprise_is_restricted / method errors) →
    // enumeration unavailable; return what we have and let the caller fall back.
    if (body.ok !== true) break;

    for (const raw of (body.teams as RawTeam[]) ?? []) {
      if (typeof raw.id !== "string" || raw.id.length === 0) continue;
      const name = typeof raw.name === "string" && raw.name.length > 0 ? raw.name : raw.id;
      teams.push({ id: raw.id, name });
    }
    const meta = body.response_metadata as { next_cursor?: string } | undefined;
    cursor = meta?.next_cursor || undefined;
  } while (cursor);

  return teams;
}

/**
 * Derive a stable, TOML-safe config alias from a workspace name (Issue #350 /
 * ADR-0014). Lower-cases, replaces any run of non-alphanumeric chars with a
 * single `-`, and trims leading/trailing `-`. Falls back to the (lower-cased)
 * team id when the name has no usable characters. Collisions are de-duplicated
 * by the caller ({@link workspaceAliases}).
 */
export function slugifyAlias(name: string, fallbackId: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallbackId.toLowerCase();
}

/**
 * Assign a unique alias to each team, preserving order. Duplicate slugs get a
 * numeric suffix (`acme`, `acme-2`, …) so every `[connectors.slack.workspaces.
 * <alias>]` block is distinct (Issue #350).
 */
export function workspaceAliases(teams: readonly SlackTeam[]): Map<string, string> {
  const byTeam = new Map<string, string>();
  const used = new Map<string, number>();
  for (const team of teams) {
    const base = slugifyAlias(team.name, team.id);
    const seen = used.get(base) ?? 0;
    const alias = seen === 0 ? base : `${base}-${seen + 1}`;
    used.set(base, seen + 1);
    byTeam.set(team.id, alias);
  }
  return byTeam;
}
