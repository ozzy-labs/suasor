/**
 * Slack Lists actuator (ADR-0036). Publishes a task as a **Slack List item**
 * (record) and issues complete / reopen against it. Distinct from the read-only
 * slack connector (`./slack.ts`); this is the egress (write) capability.
 *
 * The Slack Lists API is GA (`slackLists.items.create` / `.update` / `.list`,
 * scope `lists:write`, paid plans only). List columns are list-specific, so the
 * title / status / checkbox column ids and option ids are config-driven (like a
 * Jira workflow). List text cells must be **rich_text** (no plain string).
 *
 * - **identity** — externalId is `slack:list:<listId>:item:<rowId>`. The literal
 *   `list` second segment keeps it distinct from the read connector's
 *   `slack:<channel>:<ts>` message ids (canonical, ADR-0042; list ids `L…` and
 *   channel ids `C…/G…/D…` never collide either).
 * - **idempotency** — primarily the suasor layer's `published_external_id`. When
 *   `slackMarkerColumnId` is configured, the marker is stamped there and scanned
 *   (best-effort, first page) to absorb publish RPC retries.
 * - **complete/reopen** — set the checkbox column (when configured) or the status
 *   single-select; **comment is unsupported** (Slack List records have no comment API).
 * - **secret** — the write-scoped token comes from the unnamed pool
 *   (`ctx.secret("tokens")`, first token; ADR-0042 決定 7)
 *   (`slack-actuator` namespace, scope `lists:write`).
 *
 * Import-clean: `@slack/web-api` is lazy-imported inside the client factory.
 */
import { z } from "zod";
import type {
  Actuator,
  ActuatorAction,
  ActuatorContext,
  PublishableTask,
  PublishResult,
} from "./actuator.ts";
import { taskMarker } from "./github-actuator.ts";

/** `[tasks.homes.slack]` config slice (slack-prefixed to avoid github field collision). */
export const SlackListsActuatorConfig = z.object({
  list: z.string().min(1),
  /**
   * Optional workspace (team id) disambiguator (ADR-0042 決定 7 / #471): when
   * the pool holds several tokens, tokens whose `auth.test` team matches are
   * preferred for this list. Purely an ordering hint — the bounded failover
   * still tries another token when the preferred one fails.
   */
  team: z.string().min(1).optional(),
  slackTitleColumnId: z.string().min(1),
  slackStatusColumnId: z.string().min(1).optional(),
  slackDoneOptionId: z.string().min(1).optional(),
  slackTodoOptionId: z.string().min(1).optional(),
  slackCheckboxColumnId: z.string().min(1).optional(),
  /** Status option mapped to "dropped" (won't-do); required for drop egress. */
  slackDroppedOptionId: z.string().min(1).optional(),
  slackMarkerColumnId: z.string().min(1).optional(),
});
export type SlackListsActuatorConfig = z.infer<typeof SlackListsActuatorConfig>;

/** A typed Slack List field value (column_id + one type key). */
export type SlackListField = { column_id: string } & Record<string, unknown>;

/** Wrap plain text in a Slack rich_text block (List text cells require rich_text). */
export function textToRichText(text: string): unknown[] {
  return [
    {
      type: "rich_text",
      elements: [{ type: "rich_text_section", elements: [{ type: "text", text }] }],
    },
  ];
}

/** The Slack Lists API surface this actuator depends on (structural, for test fakes). */
export interface SlackListsClient {
  /**
   * `auth.test` self-description for the optional `team` disambiguator (#471).
   * Optional: a fake without it (or a probe failure) skips team matching and
   * keeps the pool order.
   */
  authTest?(): Promise<{ ok?: boolean; team_id?: string }>;
  /** Find an item whose `columnId` text cell contains `marker` → its row id, or null. */
  findItemByMarker(args: {
    listId: string;
    columnId: string;
    marker: string;
  }): Promise<string | null>;
  /** Create a list item → its row id. */
  createItem(args: { listId: string; initialFields: SlackListField[] }): Promise<string>;
  /** Update a single field (cell) of a list item. */
  updateField(args: { listId: string; rowId: string; field: SlackListField }): Promise<void>;
}

/** How the actuator obtains its client (overridable in tests). */
export type SlackListsClientFactory = (token: string) => SlackListsClient;

/** Default factory: lazy-imports `@slack/web-api` (import-clean, mirrors slack.ts). */
const defaultClientFactory: SlackListsClientFactory = (token) => {
  let cached: { apiCall(method: string, args: Record<string, unknown>): Promise<unknown> } | null =
    null;
  async function web() {
    if (!cached) {
      const { WebClient } = await import("@slack/web-api");
      cached = new WebClient(token) as unknown as typeof cached;
    }
    return cached as { apiCall(method: string, args: Record<string, unknown>): Promise<unknown> };
  }
  return {
    async authTest() {
      const w = await web();
      return (await w.apiCall("auth.test", {})) as { ok?: boolean; team_id?: string };
    },
    async findItemByMarker({ listId, columnId, marker }) {
      const w = await web();
      const res = (await w.apiCall("slackLists.items.list", { list_id: listId, limit: 100 })) as {
        items?: Array<{
          id?: string;
          fields?: Array<{ key?: string; column_id?: string; text?: string }>;
        }>;
      };
      // `items.list` keys cells by `key` (always present); `column_id` is optional
      // in responses. Match the configured column id against either.
      const hit = res.items?.find((it) =>
        it.fields?.some(
          (f) =>
            (f.column_id === columnId || f.key === columnId) &&
            typeof f.text === "string" &&
            f.text.includes(marker),
        ),
      );
      return hit?.id ?? null;
    },
    async createItem({ listId, initialFields }) {
      const w = await web();
      const res = (await w.apiCall("slackLists.items.create", {
        list_id: listId,
        initial_fields: initialFields,
      })) as { item?: { id?: string }; item_id?: string };
      const id = res.item?.id ?? res.item_id;
      if (!id) throw new Error("slackLists.items.create returned no item id");
      return id;
    },
    async updateField({ listId, rowId, field }) {
      const w = await web();
      const { column_id, ...value } = field;
      await w.apiCall("slackLists.items.update", {
        list_id: listId,
        row_id: rowId,
        column_id,
        ...value,
      });
    },
  };
};

/** Parse `slack:list:<listId>:item:<rowId>` → its parts (throws on a bad id). */
export function parseSlackItemExternalId(externalId: string): { listId: string; rowId: string } {
  const m = /^slack:list:([^:]+):item:(.+)$/.exec(externalId);
  const listId = m?.[1];
  const rowId = m?.[2];
  if (!listId || !rowId) {
    throw new Error(`not a slack list item externalId: ${externalId}`);
  }
  return { listId, rowId };
}

/**
 * Create the Slack Lists actuator. `clientFactory` is injectable for tests; the
 * default lazy-imports `@slack/web-api`.
 */
export function createSlackListsActuator(
  config: Record<string, unknown>,
  clientFactory: SlackListsClientFactory = defaultClientFactory,
): Actuator {
  const cfg = SlackListsActuatorConfig.parse(config);

  /**
   * Run one actuator operation with reachability-style token selection
   * (ADR-0042 決定 7 / #471): tokens matching the optional `team` disambiguator
   * go first (auth.test probe, best-effort), then pool order; the op is tried
   * on the first token plus **one** failover (the same bounded policy sync
   * uses). A publish retried after a mid-flight throw is absorbed by the marker
   * scan when `slackMarkerColumnId` is configured; otherwise a thrown create is
   * treated as not-created (unchanged from the single-token behaviour).
   */
  async function withClient<T>(
    ctx: ActuatorContext,
    op: (client: SlackListsClient) => Promise<T>,
  ): Promise<T> {
    const { parseTokenPool, SLACK_TOKENS_SECRET } = await import("./slack.ts");
    const pool = parseTokenPool(await ctx.secret(SLACK_TOKENS_SECRET));
    if (pool.length === 0) {
      throw new Error(
        "slack lists actuator: no token pool configured " +
          "(run `suasor slack auth set` or set SUASOR_CONNECTOR_SLACK_TOKENS)",
      );
    }
    let ordered = pool;
    if (cfg.team && pool.length > 1) {
      const matched: string[] = [];
      const rest: string[] = [];
      for (const token of pool) {
        let isMatch = false;
        const probe = clientFactory(token);
        if (probe.authTest) {
          try {
            const res = await probe.authTest();
            isMatch = res.ok !== false && res.team_id === cfg.team;
          } catch {
            // Best-effort: an unprobeable token just keeps its pool position.
          }
        }
        (isMatch ? matched : rest).push(token);
      }
      ordered = [...matched, ...rest];
    }
    const attempts = ordered.slice(0, 2); // picked token + one failover (ADR-0042)
    let lastError: unknown;
    for (const token of attempts) {
      try {
        return await op(clientFactory(token));
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(
      `slack lists actuator: ${attempts.length} pool token(s) failed for list '${cfg.list}' — ` +
        "add that workspace's token (`suasor slack auth set`)" +
        `${cfg.team ? "" : " or set [tasks.homes.slack].team to prefer the right workspace"}: ` +
        `${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  return {
    destination: "slack",

    async publish(task: PublishableTask, ctx: ActuatorContext): Promise<PublishResult> {
      return withClient(ctx, async (slack) => {
        const marker = taskMarker(task.taskId);
        if (cfg.slackMarkerColumnId) {
          const existing = await slack.findItemByMarker({
            listId: cfg.list,
            columnId: cfg.slackMarkerColumnId,
            marker,
          });
          if (existing) return { externalId: `slack:list:${cfg.list}:item:${existing}` };
        }
        const initialFields: SlackListField[] = [
          { column_id: cfg.slackTitleColumnId, rich_text: textToRichText(task.title) },
        ];
        if (cfg.slackMarkerColumnId) {
          initialFields.push({
            column_id: cfg.slackMarkerColumnId,
            rich_text: textToRichText(marker),
          });
        }
        const rowId = await slack.createItem({ listId: cfg.list, initialFields });
        return { externalId: `slack:list:${cfg.list}:item:${rowId}` };
      });
    },

    async act(externalId: string, action: ActuatorAction, ctx: ActuatorContext): Promise<void> {
      const { listId, rowId } = parseSlackItemExternalId(externalId);
      if (action.kind === "comment") {
        throw new Error("slack lists: comment is not supported (List records have no comment API)");
      }
      // Best-effort drop: a checkbox can't express "dropped" (only done/not-done),
      // so drop needs a dedicated status option. Without it → no-op + warn (don't
      // throw — the local cache still records the drop, ADR-0036 §3).
      if (action.kind === "drop") {
        const statusColumn = cfg.slackStatusColumnId;
        const droppedOption = cfg.slackDroppedOptionId;
        if (statusColumn && droppedOption) {
          await withClient(ctx, (slack) =>
            slack.updateField({
              listId,
              rowId,
              field: { column_id: statusColumn, select: [droppedOption] },
            }),
          );
        } else {
          ctx.onWarn?.(
            "slack: drop is a no-op (needs slackStatusColumnId + slackDroppedOptionId in [tasks.homes.slack])",
          );
        }
        return;
      }
      const done = action.kind === "complete";
      const checkboxColumn = cfg.slackCheckboxColumnId;
      if (checkboxColumn) {
        await withClient(ctx, (slack) =>
          slack.updateField({
            listId,
            rowId,
            field: { column_id: checkboxColumn, checkbox: done },
          }),
        );
        return;
      }
      const statusColumn = cfg.slackStatusColumnId;
      const optionId = done ? cfg.slackDoneOptionId : cfg.slackTodoOptionId;
      if (!statusColumn || !optionId) {
        throw new Error(
          `slack lists: ${action.kind} requires slackCheckboxColumnId, or slackStatusColumnId + ${
            done ? "slackDoneOptionId" : "slackTodoOptionId"
          } in [tasks.homes.slack]`,
        );
      }
      await withClient(ctx, (slack) =>
        slack.updateField({
          listId,
          rowId,
          field: { column_id: statusColumn, select: [optionId] },
        }),
      );
    },
  };
}
