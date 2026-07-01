/**
 * Slack conversation discovery for `slack conversations` (ADR-0011; port of
 * opshub's `conversations.py` listing path).
 *
 * Enumerates the conversations a token can see (`users.conversations`) so the
 * operator can discover channel/DM ids without hand-hunting them — the missing
 * onboarding seam between `auth test` and `sync`. Each requested type is queried
 * **independently** so a missing listing scope on one type (e.g. no
 * `groups:read`) self-reports as a per-type `missingScope` warning instead of
 * failing the whole sweep (opshub ADR-0040 §A: listing over-claims if folded
 * into readiness, so it self-reports here).
 *
 * Import-clean (ADR-0007): no Slack SDK. The default transport goes through the
 * shared rate-limit-aware `slackFetch` (ADR-0019); top-level imports stay light.
 */

import { secretEnvName } from "../secrets.ts";
import { slackFetch } from "./_fetch.ts";
import { channelOwnership } from "./dedup.ts";
import { defaultUsersTransport, resolveUserName, type SlackUsersTransport } from "./resolve.ts";

/**
 * The per-connector env override name for a workspace's token (Issue #371 theme
 * 4): `SUASOR_CONNECTOR_SLACK_<ALIAS>_TOKEN` for a named alias (`-` and other
 * non-alphanumeric chars normalised to `_`), or `SUASOR_CONNECTOR_SLACK_TOKEN`
 * for the flat/default workspace. Surfaced as a comment in the paste-ready config
 * block so the headless / WSL token override is discoverable at setup time. The
 * secret name mirrors `workspaceSecretName` in `../slack.ts` (`<alias>:token` /
 * `token`); kept as literals here to avoid a module cycle.
 */
function tokenEnvComment(alias?: string): string {
  const secret = alias ? `${alias}:token` : "token";
  const cmd = alias ? `suasor slack auth set --workspace ${alias}` : "suasor slack auth set";
  return `# token: \`${cmd}\` — or env ${secretEnvName("slack", secret)}`;
}

// Re-exported so existing importers (and tests) keep resolving the type from
// here; the SSOT now lives in `resolve.ts` (ADR-0037 §2).
export type { SlackUsersTransport } from "./resolve.ts";

/** The four conversation types this helper understands (keys match `scopes.ts`). */
export type ConversationType = "public" | "private" | "im" | "mpim";

/** Display order + the `users.conversations` `types` value for each. */
const TYPE_ORDER: readonly ConversationType[] = ["public", "private", "im", "mpim"];
const API_TYPE: Record<ConversationType, string> = {
  public: "public_channel",
  private: "private_channel",
  im: "im",
  mpim: "mpim",
};
/** The listing (`*:read`) scope each type needs — used to name a `missing_scope`. */
const LISTING_SCOPE: Record<ConversationType, string> = {
  public: "channels:read",
  private: "groups:read",
  im: "im:read",
  mpim: "mpim:read",
};

/** One conversation surfaced for the discovery CLI. */
export interface SlackConversation {
  /** Conversation id (`C…` public, `G…` private/mpim, `D…` DM). */
  readonly id: string;
  readonly type: ConversationType;
  /** Channel name (`null` for DMs/MPIMs, which Slack does not name). */
  readonly name: string | null;
  /** Best-effort human label (`#general`, `dm:U123`, the mpim's generated name). */
  readonly displayName: string;
  readonly isArchived: boolean;
  /**
   * Whether the token's principal is a member of this conversation (ADR-0011).
   * Slack returns `is_member` for channels; DMs/MPIMs are always joined (they only
   * exist for their participants). When `is_member` is absent on a channel we
   * conservatively report `false` so the CLI never marks an unreachable channel as
   * reachable — a channel the bot has not joined returns `not_in_channel` at sync
   * time. Surfaced as a join mark so reachability is visible before configuring.
   */
  readonly isMember: boolean;
  /**
   * The Enterprise Grid workspace (team) id this conversation was listed under,
   * when the sweep was scoped by {@link ListConversationsOptions.teamId} (Issue
   * #350). `undefined` for an unscoped sweep (the token's default team).
   */
  readonly teamId?: string;
}

/** Result of a discovery sweep: rows plus any per-type listing-scope gaps. */
export interface ConversationsResult {
  readonly conversations: SlackConversation[];
  /** type → the listing scope that was missing (only present types that failed). */
  readonly missingScopes: Partial<Record<ConversationType, string>>;
}

export interface ListConversationsOptions {
  /** Types to enumerate (default: all four). */
  readonly types?: readonly ConversationType[];
  /**
   * Enterprise Grid workspace (team) id to scope the listing to (Issue #350).
   * Passed as `users.conversations`'s `team_id`, which Slack honours **only for
   * org-level tokens**; a workspace-level token ignores it. When set, every
   * returned {@link SlackConversation} is tagged with this `teamId`. Omitted →
   * the token's default team (current behaviour).
   */
  readonly teamId?: string;
  /** Include archived channels (default: excluded). */
  readonly includeArchived?: boolean;
  /** Cap on total rows returned (default: no limit). */
  readonly limit?: number;
  /** Transport override (tests inject a fake; default lazy-`fetch`). */
  readonly transport?: SlackConversationsTransport;
  /** `users.info` transport override for DM name resolution (tests inject a fake). */
  readonly usersTransport?: SlackUsersTransport;
  /**
   * Called once per fetched page / resolved DM name so a CLI can render an
   * indeterminate progress counter while the sweep runs (#84). Best-effort: any
   * throw is ignored so progress reporting never fails the listing.
   */
  readonly onProgress?: () => void;
}

/** One `users.conversations` page fetch, decoupled from `fetch` for tests. */
export type SlackConversationsTransport = (
  token: string,
  params: Record<string, string>,
) => Promise<Record<string, unknown>>;

/** Default transport: a rate-limit-aware GET to `users.conversations` (ADR-0019). */
const defaultTransport: SlackConversationsTransport = async (token, params) => {
  const query = new URLSearchParams(params).toString();
  const { body } = await slackFetch(`https://slack.com/api/users.conversations?${query}`, {
    token,
  });
  return body;
};

/** Per-page ceiling (the SDK default and Slack's recommended sweet spot). */
const PAGE_LIMIT = 200;

interface RawChannel {
  id?: string;
  name?: string;
  is_archived?: boolean;
  is_member?: boolean;
  user?: string;
}

function toConversation(type: ConversationType, raw: RawChannel): SlackConversation | null {
  if (typeof raw.id !== "string" || raw.id.length === 0) return null;
  const name = typeof raw.name === "string" && raw.name.length > 0 ? raw.name : null;
  let displayName: string;
  if (type === "im") displayName = `dm:${typeof raw.user === "string" ? raw.user : raw.id}`;
  else if (type === "mpim") displayName = name ?? "group-dm";
  else displayName = name ? `#${name}` : raw.id;
  // DMs / MPIMs only exist for their participants → always joined. For channels,
  // trust Slack's `is_member`; absent → conservatively `false` (ADR-0011).
  const isMember = type === "im" || type === "mpim" ? true : raw.is_member === true;
  return {
    id: raw.id,
    type,
    name,
    displayName,
    isArchived: raw.is_archived === true,
    isMember,
  };
}

/**
 * Enumerate the conversations a token can see, type by type.
 *
 * Each type is swept with cursor pagination; a `missing_scope` error on one type
 * records a `missingScopes[type]` entry (the `needed` scope from the response,
 * falling back to the canonical listing scope) and moves on. Non-scope errors
 * throw (with the Slack `error` code, never the token).
 *
 * @throws {Error} when `users.conversations` fails for a non-scope reason.
 */
export async function listConversations(
  token: string,
  options: ListConversationsOptions = {},
): Promise<ConversationsResult> {
  const types = options.types ?? TYPE_ORDER;
  const transport = options.transport ?? defaultTransport;
  const usersTransport = options.usersTransport ?? defaultUsersTransport;
  // Best-effort progress tick: a throw in the reporter must not fail the sweep.
  const tick = () => {
    try {
      options.onProgress?.();
    } catch {}
  };
  const nameCache = new Map<string, string | null>();
  const conversations: SlackConversation[] = [];
  const missingScopes: Partial<Record<ConversationType, string>> = {};

  for (const type of types) {
    // Collect the whole type first so it can be sorted a-z before output
    // (opshub default `sort=name` parity); the limit caps the OUTPUT, not the fetch.
    const typeRows: SlackConversation[] = [];
    let cursor: string | undefined;
    do {
      const params: Record<string, string> = {
        types: API_TYPE[type],
        limit: String(PAGE_LIMIT),
        exclude_archived: options.includeArchived ? "false" : "true",
      };
      // Scope to a specific Enterprise Grid workspace when requested (Issue
      // #350). Slack honours `team_id` only for org-level tokens; a
      // workspace-level token ignores it (the CLI warns before this call).
      if (options.teamId) params.team_id = options.teamId;
      if (cursor) params.cursor = cursor;

      const body = await transport(token, params);
      tick(); // one page fetched
      if (body.ok !== true) {
        const error = typeof body.error === "string" ? body.error : "unknown";
        if (error === "missing_scope") {
          const needed =
            typeof body.needed === "string" && body.needed.length > 0
              ? body.needed
              : LISTING_SCOPE[type];
          missingScopes[type] = needed;
          break;
        }
        throw new Error(`slack users.conversations (${type}) failed: ${error}`);
      }

      for (const raw of (body.channels as RawChannel[]) ?? []) {
        let conv = toConversation(type, raw);
        if (!conv) continue;
        // Tag each row with the scoped workspace so multi-workspace callers can
        // group by team (Issue #350); undefined when the sweep is unscoped.
        if (options.teamId) conv = { ...conv, teamId: options.teamId };
        // DM rows have no name — resolve the counterpart's display name so the
        // listing shows a person, not a `dm:U123` id (opshub parity).
        if (type === "im" && typeof raw.user === "string") {
          const resolved = await resolveUserName(token, raw.user, usersTransport, nameCache);
          tick(); // one DM counterpart resolved (the slow, per-row users.info loop)
          if (resolved) conv = { ...conv, displayName: `dm:${resolved}` };
        }
        typeRows.push(conv);
      }
      const meta = body.response_metadata as { next_cursor?: string } | undefined;
      cursor = meta?.next_cursor || undefined;
    } while (cursor);

    // Sort a-z within the type by display name (case-insensitive), then output.
    typeRows.sort((a, b) =>
      a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }),
    );
    for (const conv of typeRows) {
      conversations.push(conv);
      if (options.limit !== undefined && conversations.length >= options.limit) {
        return { conversations, missingScopes };
      }
    }
  }

  return { conversations, missingScopes };
}

/**
 * Render a `[connectors.slack]` config block the operator can paste straight
 * into `config.toml`. The `channels` array carries every discovered id (any
 * conversation type) with a trailing `# <displayName>` comment.
 */
export function renderConfigBlock(teamId: string, result: ConversationsResult): string[] {
  const lines = ["[connectors.slack]", "enabled = true", tokenEnvComment(), `team = "${teamId}"`];
  if (result.conversations.length === 0) {
    lines.push("channels = []");
    return lines;
  }
  // `channels` carries conversation *ids*, not names — a name silently ingests
  // zero messages (Issue #158). The trailing comment is the display name for
  // readability only; the quoted value is the id to keep.
  lines.push("# channels are ids (C…/G…/D…), not names — the # comment is just a label");
  lines.push("channels = [");
  for (const c of result.conversations) {
    lines.push(`  "${c.id}",  # ${c.displayName}`);
  }
  lines.push("]");
  return lines;
}

/** One workspace's discovered conversations for the multi-workspace config block. */
export interface WorkspaceConfigInput {
  readonly teamId: string;
  /** TOML-safe alias for the `[connectors.slack.workspaces.<alias>]` section. */
  readonly alias: string;
  readonly conversations: readonly SlackConversation[];
}

/**
 * Render a multi-workspace `[connectors.slack]` block for an Enterprise Grid
 * sweep (Issue #350 / ADR-0014). Emits the load-bearing `enabled = true` on the
 * connector once, then one `[connectors.slack.workspaces.<alias>]` sub-section
 * per workspace carrying that workspace's `team` id + discovered `channels`.
 *
 * This is the multi-workspace analogue of {@link renderConfigBlock}: the flat
 * form lumps every id under a single `team`, which mis-prefixes ids from other
 * workspaces at sync time (identity is `slack:<team>:<channel>:<ts>`). Grouping
 * by workspace keeps each id under its own team.
 *
 * A channel shared across several workspaces (one global channel id listed by
 * more than one alias) is de-duplicated so pasting the whole block does not
 * double-configure it (ADR-0038 Layer 2): it is emitted as a real `channels`
 * entry only under its **owner** — the lexicographically smallest alias, per the
 * shared {@link channelOwnership} rule sync uses — and shown as a
 * `# <id> shared, owned by <owner-alias>` comment under every non-owner block.
 */
export function renderWorkspacesConfigBlock(workspaces: readonly WorkspaceConfigInput[]): string[] {
  // Owner = lexicographically smallest alias listing the channel (ADR-0038 §2),
  // reusing the same helper sync/config-doctor use so discovery marks the exact
  // same owner sync would ingest under. `shared` names the ≥2-alias channels.
  const { owner, shared } = channelOwnership(
    workspaces.map((ws) => ({ alias: ws.alias, channels: ws.conversations.map((c) => c.id) })),
  );
  const sharedOwner = new Map(shared.map((s) => [s.channel, s.owner]));

  const lines = ["[connectors.slack]", "enabled = true"];
  for (const ws of workspaces) {
    // Each workspace needs its own token (Issue #371 theme 4): surface the
    // per-workspace `slack auth set` command + env override so a pasted multi
    // block does not silently hit `workspace 'X' skipped: no token` at sync time.
    lines.push(
      "",
      `[connectors.slack.workspaces.${ws.alias}]`,
      tokenEnvComment(ws.alias),
      `team = "${ws.teamId}"`,
    );
    if (ws.conversations.length === 0) {
      lines.push("channels = []");
      continue;
    }
    lines.push("# channels are ids (C…/G…/D…), not names — the # comment is just a label");
    lines.push("channels = [");
    for (const c of ws.conversations) {
      // A shared channel is owned by exactly one alias; under any other alias it
      // is a comment, not an entry, so pasting every block ingests it once
      // (owner-wins, ADR-0038 Layer 2). Non-shared channels are unaffected —
      // their owner is their sole alias, so the `owner === ws.alias` test passes.
      if (sharedOwner.has(c.id) && owner.get(c.id) !== ws.alias) {
        lines.push(`  # ${c.id} shared, owned by ${owner.get(c.id)}  # ${c.displayName}`);
      } else {
        lines.push(`  "${c.id}",  # ${c.displayName}`);
      }
    }
    lines.push("]");
  }
  return lines;
}
