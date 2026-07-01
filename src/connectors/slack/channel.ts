/**
 * Slack channel name + kind resolver (ADR-0037 §3/§4/§5).
 *
 * Resolves a conversation id (`C…/G…/D…`) to a human-readable name and a `kind`
 * at sync time, so the `slack_channels` projection can be joined at display time
 * without a live fetch (no-fetch-at-query, ADR-0012). Best-effort: any failure
 * (missing scope, API error) degrades to an empty name + an id-prefix-derived
 * kind (ADR-0037 §6), never throwing, so ingest keeps its id fallback.
 *
 * Resolution goes through the injected Slack client's `conversations.info` /
 * `conversations.members` — the same rate-limit-aware `@slack/web-api` transport
 * the sync hot path (`conversations.history` / `replies`) already uses (ADR-0019),
 * and the same seam tests already override via the connector's `clientFactory`.
 * A caller-held `channelCache` keeps each id resolved at most once per run
 * (ADR-0037 §5). DM / group-DM participant names reuse `resolveUserName`
 * (`users.info`, ADR-0037 §2) so the fallback order lives in one place.
 */

import type { SlackChannelKind } from "../../events/types.ts";
import { resolveUserName, type SlackUsersTransport } from "./resolve.ts";

/** Subset of `conversations.info`'s `channel` object we read. */
interface RawChannelInfo {
  name?: string;
  is_private?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  /** Counterpart user id on a single DM (`is_im`). */
  user?: string;
}

/**
 * The minimal Slack client surface this resolver needs (structural, so it is
 * satisfied by the connector's richer `SlackClientLike`). Both methods are
 * optional: a fake client without them (or a workspace missing the scope)
 * degrades to id-only rather than reaching the network — no test churn, no
 * silent live fetch.
 */
export interface SlackChannelInfoClient {
  conversations: {
    info?: (args: { channel: string }) => Promise<{ ok?: boolean; channel?: RawChannelInfo }>;
    members?: (args: { channel: string }) => Promise<{ ok?: boolean; members?: string[] }>;
  };
}

/** A resolved channel: a display name (`""` when unresolved) and its kind. */
export interface ResolvedChannel {
  /** Human name; `""` on degrade → the display layer falls back to the id (§6). */
  name: string;
  kind: SlackChannelKind;
}

/** Return the trimmed value when it is a non-empty string, else `undefined`. */
function firstNonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Best-effort channel kind from the id prefix alone (ADR-0037 §3): `D…` DM,
 * `G…` group DM, else a `C…` channel (refined to `private` via the API's
 * `is_private`). Used as the fallback when `conversations.info` is unavailable.
 */
export function channelKindFromId(channelId: string): SlackChannelKind {
  const first = channelId.trim()[0];
  if (first === "D") return "dm";
  if (first === "G") return "group";
  return "public";
}

/** Join the (self-excluded) member display names of a group DM (ADR-0037 §4). */
async function resolveGroupName(
  client: SlackChannelInfoClient,
  token: string,
  channelId: string,
  selfUserId: string | undefined,
  usersTransport: SlackUsersTransport,
  userCache: Map<string, string | null>,
): Promise<string> {
  const membersFn = client.conversations.members;
  if (!membersFn) return "";
  try {
    const body = await membersFn({ channel: channelId });
    if (body.ok === false || !Array.isArray(body.members)) return "";
    const names: string[] = [];
    for (const member of body.members) {
      if (typeof member !== "string" || member === "") continue;
      if (selfUserId && member === selfUserId) continue; // exclude self (ADR-0012/0022)
      const name = await resolveUserName(token, member, usersTransport, userCache);
      names.push(name ?? member); // ID fallback for an unresolvable participant (§4)
    }
    return names.join(", ");
  } catch {
    return ""; // members fetch failed → whole-channel id fallback (§6)
  }
}

/**
 * Resolve a Slack conversation id to a `{ name, kind }` (ADR-0037 §3/§4/§5).
 *
 * - **public / private** — `conversations.info.channel.name`; kind from
 *   `is_private` (else the id prefix).
 * - **single DM (`D…`)** — the counterpart's (`channel.user`) display name via
 *   `resolveUserName` (§5).
 * - **group DM** — a join of the self-excluded participants' names (§4).
 *
 * Degrades to `{ name: "", kind: <from id prefix> }` on any failure (§6). The
 * `channelCache` resolves each id at most once per run (§5).
 */
export async function resolveChannel(
  client: SlackChannelInfoClient,
  token: string,
  channelId: string,
  selfUserId: string | undefined,
  usersTransport: SlackUsersTransport,
  userCache: Map<string, string | null>,
  channelCache: Map<string, ResolvedChannel>,
): Promise<ResolvedChannel> {
  const cached = channelCache.get(channelId);
  if (cached !== undefined) return cached;

  let result: ResolvedChannel = { name: "", kind: channelKindFromId(channelId) };
  try {
    const infoFn = client.conversations.info;
    if (infoFn) {
      const body = await infoFn({ channel: channelId });
      if (body.ok !== false && body.channel) {
        const ch = body.channel;
        // Prefer the API classification; fall back to the id prefix when it can't
        // classify (e.g. a legacy `G…` that is neither is_mpim nor is_private).
        const kind: SlackChannelKind = ch.is_im
          ? "dm"
          : ch.is_mpim
            ? "group"
            : ch.is_private
              ? "private"
              : channelKindFromId(channelId);
        let name = "";
        if (kind === "dm") {
          const counterpart = firstNonEmpty(ch.user);
          if (counterpart) {
            name = (await resolveUserName(token, counterpart, usersTransport, userCache)) ?? "";
          }
        } else if (kind === "group") {
          name = await resolveGroupName(
            client,
            token,
            channelId,
            selfUserId,
            usersTransport,
            userCache,
          );
        } else {
          name = firstNonEmpty(ch.name) ?? "";
        }
        result = { name, kind };
      }
    }
  } catch {
    result = { name: "", kind: channelKindFromId(channelId) }; // best-effort (§6)
  }

  channelCache.set(channelId, result);
  return result;
}
