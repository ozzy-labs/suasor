/**
 * Shared Slack user-name resolver (ADR-0037 §2 / §5).
 *
 * `users.info` id → display-name resolution with a caller-held per-run cache,
 * factored out of `conversations.ts` so both the discovery listing (DM
 * counterpart names) and the sync path (message author names → person
 * projection) resolve names the **same way** — one SSOT for the fallback order
 * (`display_name → profile.real_name → real_name → name`), the cache semantics,
 * and the best-effort degrade (ADR-0037 §6: a resolution failure returns `null`,
 * never throws, so ingest / listing keeps its id fallback).
 *
 * Import-clean (ADR-0007): no Slack SDK. The default transport goes through the
 * shared rate-limit-aware `slackFetch` (ADR-0019); top-level imports stay light.
 */

import { slackFetch } from "./_fetch.ts";

/** One `users.info` fetch (id → profile), decoupled from `fetch` for tests. */
export type SlackUsersTransport = (
  token: string,
  userId: string,
) => Promise<Record<string, unknown>>;

/** Default `users.info` transport: a rate-limit-aware GET resolving id → profile. */
export const defaultUsersTransport: SlackUsersTransport = async (token, userId) => {
  const { body } = await slackFetch(
    `https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`,
    { token },
  );
  return body;
};

/** Return the value when it is a non-empty string, else `undefined`. */
function firstNonEmpty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * Resolve a Slack user id to a human display name (ADR-0011 / ADR-0037 §2).
 * Best-effort: profile display name → profile/user real name → handle. Returns
 * `null` on any failure (missing `users:read`, rate limit, `ok:false`) so the
 * caller keeps its id fallback rather than erroring (ADR-0037 §6 degrade). The
 * `cache` is caller-held and keyed by `userId` so the same id resolves the
 * transport at most once per run (ADR-0037 §5 per-run cache).
 */
export async function resolveUserName(
  token: string,
  userId: string,
  transport: SlackUsersTransport,
  cache: Map<string, string | null>,
): Promise<string | null> {
  const cached = cache.get(userId);
  if (cached !== undefined) return cached;
  let name: string | null = null;
  try {
    const body = await transport(token, userId);
    if (body.ok === true) {
      const user = body.user as
        | {
            name?: string;
            real_name?: string;
            profile?: { display_name?: string; real_name?: string };
          }
        | undefined;
      name =
        firstNonEmpty(user?.profile?.display_name) ??
        firstNonEmpty(user?.profile?.real_name) ??
        firstNonEmpty(user?.real_name) ??
        firstNonEmpty(user?.name) ??
        null;
    }
  } catch {
    name = null; // resolution is best-effort; keep the id fallback
  }
  cache.set(userId, name);
  return name;
}
