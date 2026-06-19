/**
 * Slack engagement axis via `search.messages` (ADR-0013).
 *
 * Resolves, per conversation, the ts of the operator's most recent own post
 * ("last_self_post") by paging `search.messages?query=from:me`. Used to sort
 * `slack conversations` by engagement. `search:read` is a **User Token-only**
 * scope (a Bot Token structurally cannot hold it — opshub ADR-0034), so callers
 * gate this on `principal === "user"`.
 *
 * Two caveats the caller surfaces to the operator:
 * - **User Token only**: with a Bot Token the engagement axis is `N/A`.
 * - **Index lag**: Slack's full-text index lags real time, so last_self_post is
 *   an approximate "most recent engagement", not an exact value.
 *
 * Import-clean (ADR-0007): no Slack SDK. The default transport goes through the
 * shared rate-limit-aware `slackFetch` (ADR-0019); top-level imports stay light.
 */

import { slackFetch } from "./_fetch.ts";

/** One `search.messages` page fetch, decoupled from `fetch` for tests. */
export type SlackSearchTransport = (
  token: string,
  params: Record<string, string>,
) => Promise<Record<string, unknown>>;

/** Default transport: a rate-limit-aware GET to `search.messages` with query params. */
const defaultTransport: SlackSearchTransport = async (token, params) => {
  const query = new URLSearchParams(params).toString();
  const { body } = await slackFetch(`https://slack.com/api/search.messages?${query}`, { token });
  return body;
};

/** Per-page match count (Slack's `search.messages` ceiling is 100). */
const PAGE_COUNT = 100;
/** Safety bound on pages walked, so an unbounded `paging` never loops forever. */
const MAX_PAGES = 20;

interface SearchMatch {
  ts?: string;
  channel?: { id?: string };
}

export interface SearchLastSelfPostOptions {
  /** Transport override (tests inject a fake; default lazy-`fetch`). */
  readonly transport?: SlackSearchTransport;
  /**
   * Called once per fetched search page so a CLI can render an indeterminate
   * progress counter while the (up to 20-page) sweep runs (#84). Best-effort:
   * any throw is ignored so progress reporting never fails the search.
   */
  readonly onProgress?: () => void;
}

/**
 * Return a `channelId → last self-post ts` map by paging `search.messages` with
 * `from:me`. Keeps the highest ts seen per channel.
 *
 * @throws {Error} when `search.messages` fails (message carries the Slack
 *   `error` code, never the token).
 */
export async function searchLastSelfPost(
  token: string,
  options: SearchLastSelfPostOptions = {},
): Promise<Map<string, string>> {
  const transport = options.transport ?? defaultTransport;
  const result = new Map<string, string>();

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const body = await transport(token, {
      query: "from:me",
      count: String(PAGE_COUNT),
      page: String(page),
      sort: "timestamp",
    });
    // Best-effort progress tick: a throw in the reporter must not fail the search.
    try {
      options.onProgress?.();
    } catch {}
    if (body.ok !== true) {
      const error = typeof body.error === "string" ? body.error : "unknown";
      throw new Error(`slack search.messages failed: ${error}`);
    }
    const messages = body.messages as
      | { matches?: SearchMatch[]; paging?: { pages?: number; page?: number } }
      | undefined;
    for (const match of messages?.matches ?? []) {
      const channelId = match.channel?.id;
      const ts = match.ts;
      if (!channelId || !ts) continue;
      const prev = result.get(channelId);
      if (prev === undefined || Number.parseFloat(ts) > Number.parseFloat(prev)) {
        result.set(channelId, ts);
      }
    }
    const pages = messages?.paging?.pages ?? 1;
    if (page >= pages) break;
  }

  return result;
}

/**
 * Order conversations by engagement (last self-post ts, descending). Items with
 * no recorded self-post sort last (ts 0). Pure + stable-friendly so the
 * `slack conversations --sort=last_self_post` ordering is unit-testable.
 */
export function sortByLastSelfPost<T extends { id: string }>(
  conversations: readonly T[],
  lastSelfPost: Map<string, string>,
): T[] {
  const score = (id: string) => Number.parseFloat(lastSelfPost.get(id) ?? "0");
  return [...conversations].sort((a, b) => score(b.id) - score(a.id));
}
