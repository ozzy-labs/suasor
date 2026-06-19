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
 * Import-clean (ADR-0007): no Slack SDK. The default transport uses the global
 * `fetch` lazily; top-level imports are types only.
 */

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
  /** Include archived channels (default: excluded). */
  readonly includeArchived?: boolean;
  /** Cap on total rows returned (default: no limit). */
  readonly limit?: number;
  /** Transport override (tests inject a fake; default lazy-`fetch`). */
  readonly transport?: SlackConversationsTransport;
}

/** One `users.conversations` page fetch, decoupled from `fetch` for tests. */
export type SlackConversationsTransport = (
  token: string,
  params: Record<string, string>,
) => Promise<Record<string, unknown>>;

/** Default transport: a `fetch` GET to `users.conversations` with query params. */
const defaultTransport: SlackConversationsTransport = async (token, params) => {
  const query = new URLSearchParams(params).toString();
  const res = await fetch(`https://slack.com/api/users.conversations?${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return (await res.json()) as Record<string, unknown>;
};

/** Per-page ceiling (the SDK default and Slack's recommended sweet spot). */
const PAGE_LIMIT = 200;

interface RawChannel {
  id?: string;
  name?: string;
  is_archived?: boolean;
  user?: string;
}

function toConversation(type: ConversationType, raw: RawChannel): SlackConversation | null {
  if (typeof raw.id !== "string" || raw.id.length === 0) return null;
  const name = typeof raw.name === "string" && raw.name.length > 0 ? raw.name : null;
  let displayName: string;
  if (type === "im") displayName = `dm:${typeof raw.user === "string" ? raw.user : raw.id}`;
  else if (type === "mpim") displayName = name ?? "group-dm";
  else displayName = name ? `#${name}` : raw.id;
  return { id: raw.id, type, name, displayName, isArchived: raw.is_archived === true };
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
  const conversations: SlackConversation[] = [];
  const missingScopes: Partial<Record<ConversationType, string>> = {};

  for (const type of types) {
    let cursor: string | undefined;
    let stop = false;
    do {
      const params: Record<string, string> = {
        types: API_TYPE[type],
        limit: String(PAGE_LIMIT),
        exclude_archived: options.includeArchived ? "false" : "true",
      };
      if (cursor) params.cursor = cursor;

      const body = await transport(token, params);
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
        const conv = toConversation(type, raw);
        if (conv) conversations.push(conv);
        if (options.limit !== undefined && conversations.length >= options.limit) {
          stop = true;
          break;
        }
      }
      const meta = body.response_metadata as { next_cursor?: string } | undefined;
      cursor = !stop && meta?.next_cursor ? meta.next_cursor : undefined;
    } while (cursor);

    if (stop) break;
  }

  return { conversations, missingScopes };
}

/**
 * Render a `[connectors.slack]` config block the operator can paste straight
 * into `config.toml`. The `channels` array carries every discovered id (any
 * conversation type) with a trailing `# <displayName>` comment.
 */
export function renderConfigBlock(teamId: string, result: ConversationsResult): string[] {
  const lines = ["[connectors.slack]", "enabled = true", `team = "${teamId}"`];
  if (result.conversations.length === 0) {
    lines.push("channels = []");
    return lines;
  }
  lines.push("channels = [");
  for (const c of result.conversations) {
    lines.push(`  "${c.id}",  # ${c.displayName}`);
  }
  lines.push("]");
  return lines;
}
