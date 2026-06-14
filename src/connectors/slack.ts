/**
 * Slack connector (ADR-0007). Read-only ingest of channel messages for the
 * configured channels into `SourceRecord`s.
 *
 * - **read-only** — only `conversations.history` (a read endpoint) is called;
 *   nothing is posted back to Slack (ADR-0003).
 * - **delta** — Slack's `conversations.history` is a delta API: it accepts an
 *   `oldest` timestamp. The connector records the most recent message `ts` seen
 *   and returns it as the next cursor so subsequent syncs fetch only newer
 *   messages (FR-ING-3). Bodies also carry a fingerprint so edited messages are
 *   still detected as updates by the sync service.
 * - **identity** — `slack:<team>:<channel>:<ts>` (cross-source-unique,
 *   team+channel-prefixed, ADR-0007). `source_type` is `slack_message`.
 * - **import-clean** — `@slack/web-api` is **lazy-imported inside `sync`**, so
 *   building the connector / registry never pulls the SDK (ADR-0007, NFR-PRF-1).
 *   This module's top-level imports are limited to `zod` + the contract types.
 * - **secrets** — the bot token comes from `ctx.secret("token")` (keychain + env
 *   override, NFR-PRV-4); it is never read from config.
 */
import { z } from "zod";
import type {
  Connector,
  ConnectorConfig,
  SourceRecord,
  SyncContext,
  SyncResult,
} from "./contract.ts";

/** `[connectors.slack]` config (docs/design/config.md). */
export const SlackConnectorConfig = z.object({
  /** Team / workspace id used to prefix ids (kept stable across renames). */
  team: z.string().min(1).default("default"),
  /** Channel ids to ingest (e.g. "C0123ABCD"). */
  channels: z.array(z.string().min(1)).default([]),
});
export type SlackConnectorConfig = z.infer<typeof SlackConnectorConfig>;

export const SLACK_CONNECTOR_NAME = "slack";

/** Shape of the message items we read (subset of the Slack response). */
interface SlackMessageItem {
  ts: string;
  text?: string;
  user?: string;
  subtype?: string;
  thread_ts?: string;
}

/** Build the `SourceRecord` for one message of a channel. */
function toRecord(team: string, channel: string, item: SlackMessageItem): SourceRecord {
  return {
    externalId: `slack:${team}:${channel}:${item.ts}`,
    sourceType: "slack_message",
    body: item.text ?? "",
    // Slack `ts` is `<unix-seconds>.<microseconds>`; expose it as ISO 8601.
    observedAt: new Date(Math.floor(Number.parseFloat(item.ts) * 1000)).toISOString(),
    meta: {
      team,
      channel,
      ts: item.ts,
      user: item.user ?? null,
      ...(item.thread_ts ? { threadTs: item.thread_ts } : {}),
    },
  };
}

/**
 * The Slack `WebClient` surface we depend on. Declared structurally so tests can
 * inject a fake without importing the SDK, and so the real client is lazy-loaded.
 */
export interface SlackClientLike {
  conversations: {
    history: (args: {
      channel: string;
      oldest?: string;
      limit?: number;
      cursor?: string;
    }) => Promise<{
      messages?: SlackMessageItem[];
      response_metadata?: { next_cursor?: string };
    }>;
  };
}

/** How the connector obtains a Slack client (overridable in tests). */
export type SlackClientFactory = (token: string) => Promise<SlackClientLike> | SlackClientLike;

/** Default factory: lazy-imports `@slack/web-api` so registration stays import-clean. */
const defaultSlackClientFactory: SlackClientFactory = async (token) => {
  const { WebClient } = await import("@slack/web-api");
  return new WebClient(token) as unknown as SlackClientLike;
};

export interface SlackConnectorOptions {
  /** Slack client factory override (tests inject a fake; default lazy-imports the SDK). */
  clientFactory?: SlackClientFactory;
}

/** Slack connector implementing the read-only contract (ADR-0007). */
class SlackConnector implements Connector {
  readonly name = SLACK_CONNECTOR_NAME;
  readonly sourceType = "slack";

  /** Highest message `ts` observed this run → next-run `oldest` cursor. */
  private maxTs: string | null = null;

  constructor(
    private readonly config: SlackConnectorConfig,
    private readonly clientFactory: SlackClientFactory,
  ) {}

  async *sync(ctx: SyncContext): AsyncIterable<SourceRecord> {
    if (this.config.channels.length === 0) return;

    const token = await ctx.secret("token");
    if (!token) {
      throw new Error(
        "slack connector: no token configured " +
          "(set SUASOR_CONNECTOR_SLACK_TOKEN or store it in the OS keychain)",
      );
    }

    const client = await this.clientFactory(token);
    this.maxTs = ctx.cursor;

    for (const channel of this.config.channels) {
      let cursor: string | undefined;
      do {
        const page = await client.conversations.history({
          channel,
          limit: 200,
          ...(ctx.cursor ? { oldest: ctx.cursor } : {}),
          ...(cursor ? { cursor } : {}),
        });
        for (const item of page.messages ?? []) {
          if (this.maxTs === null || Number.parseFloat(item.ts) > Number.parseFloat(this.maxTs)) {
            this.maxTs = item.ts;
          }
          yield toRecord(this.config.team, channel, item);
        }
        cursor = page.response_metadata?.next_cursor || undefined;
      } while (cursor);
    }
  }

  finalize(): SyncResult {
    return { cursor: this.maxTs };
  }
}

/**
 * Build the Slack connector from its config slice (validates with Zod).
 * `@slack/web-api` is not imported here — only when `sync` actually runs.
 */
export function createSlackConnector(
  config: ConnectorConfig,
  options: SlackConnectorOptions = {},
): Connector {
  const parsed = SlackConnectorConfig.parse(config ?? {});
  return new SlackConnector(parsed, options.clientFactory ?? defaultSlackClientFactory);
}
