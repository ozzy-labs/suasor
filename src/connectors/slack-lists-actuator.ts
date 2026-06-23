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
 *   `slack:<team>:<channel>:<ts>` message ids.
 * - **idempotency** — primarily the suasor layer's `published_external_id`. When
 *   `slackMarkerColumnId` is configured, the marker is stamped there and scanned
 *   (best-effort, first page) to absorb publish RPC retries.
 * - **complete/reopen** — set the checkbox column (when configured) or the status
 *   single-select; **comment is unsupported** (Slack List records have no comment API).
 * - **secret** — the write-scoped token comes from `ctx.secret("token")`
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

/** `[tasks.home]` slack config slice (slack-prefixed to avoid github field collision). */
export const SlackListsActuatorConfig = z.object({
  list: z.string().min(1),
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
    async findItemByMarker({ listId, columnId, marker }) {
      const w = await web();
      const res = (await w.apiCall("slackLists.items.list", { list_id: listId, limit: 100 })) as {
        items?: Array<{ id?: string; fields?: Array<{ column_id?: string; text?: string }> }>;
      };
      const hit = res.items?.find((it) =>
        it.fields?.some(
          (f) => f.column_id === columnId && typeof f.text === "string" && f.text.includes(marker),
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

  async function client(ctx: ActuatorContext): Promise<SlackListsClient> {
    const token = await ctx.secret("token");
    if (!token) {
      throw new Error("slack lists actuator: missing write-scoped token (secret 'token')");
    }
    return clientFactory(token);
  }

  return {
    destination: "slack",

    async publish(task: PublishableTask, ctx: ActuatorContext): Promise<PublishResult> {
      const slack = await client(ctx);
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
        if (cfg.slackStatusColumnId && cfg.slackDroppedOptionId) {
          const slack = await client(ctx);
          await slack.updateField({
            listId,
            rowId,
            field: { column_id: cfg.slackStatusColumnId, select: [cfg.slackDroppedOptionId] },
          });
        } else {
          ctx.onWarn?.(
            "slack: drop is a no-op (needs slackStatusColumnId + slackDroppedOptionId in [tasks.home])",
          );
        }
        return;
      }
      const slack = await client(ctx);
      const done = action.kind === "complete";
      if (cfg.slackCheckboxColumnId) {
        await slack.updateField({
          listId,
          rowId,
          field: { column_id: cfg.slackCheckboxColumnId, checkbox: done },
        });
        return;
      }
      const optionId = done ? cfg.slackDoneOptionId : cfg.slackTodoOptionId;
      if (!cfg.slackStatusColumnId || !optionId) {
        throw new Error(
          `slack lists: ${action.kind} requires slackCheckboxColumnId, or slackStatusColumnId + ${
            done ? "slackDoneOptionId" : "slackTodoOptionId"
          } in [tasks.home]`,
        );
      }
      await slack.updateField({
        listId,
        rowId,
        field: { column_id: cfg.slackStatusColumnId, select: [optionId] },
      });
    },
  };
}
