import { describe, expect, test } from "bun:test";
import type { ActuatorContext } from "../../src/connectors/actuator.ts";
import { taskMarker } from "../../src/connectors/github-actuator.ts";
import {
  createSlackListsActuator,
  parseSlackItemExternalId,
  type SlackListsClient,
  textToRichText,
} from "../../src/connectors/slack-lists-actuator.ts";

function fakeClient(seed: { existing?: Record<string, string> } = {}) {
  const created: Array<{ listId: string; initialFields: Array<Record<string, unknown>> }> = [];
  const updates: Array<{ rowId: string; field: Record<string, unknown> }> = [];
  const byMarker = new Map<string, string>(Object.entries(seed.existing ?? {}));
  let next = 1;
  const client: SlackListsClient = {
    async findItemByMarker({ marker }) {
      return byMarker.get(marker) ?? null;
    },
    async createItem({ listId, initialFields }) {
      created.push({ listId, initialFields });
      return `Rec${next++}`;
    },
    async updateField({ rowId, field }) {
      updates.push({ rowId, field });
    },
  };
  return { client, created, updates };
}

const ctx: ActuatorContext = { secret: async () => "xoxb-token" };
const checkboxCfg = {
  list: "L1",
  slackTitleColumnId: "ColTitle",
  slackCheckboxColumnId: "ColDone",
};
const statusCfg = {
  list: "L1",
  slackTitleColumnId: "ColTitle",
  slackStatusColumnId: "ColStatus",
  slackDoneOptionId: "opt_done",
  slackTodoOptionId: "opt_todo",
};

describe("slack-lists-actuator publish", () => {
  test("creates an item with a rich_text title, returns slack list externalId", async () => {
    const fake = fakeClient();
    const actuator = createSlackListsActuator(checkboxCfg, () => fake.client);
    const result = await actuator.publish({ taskId: "t1", title: "Review" }, ctx);
    expect(result.externalId).toBe("slack:list:L1:item:Rec1");
    expect(fake.created[0]?.initialFields[0]).toEqual({
      column_id: "ColTitle",
      rich_text: textToRichText("Review"),
    });
  });

  test("idempotent via marker column: reuses an existing item, no create", async () => {
    const fake = fakeClient({ existing: { [taskMarker("t1")]: "RecX" } });
    const actuator = createSlackListsActuator(
      { ...checkboxCfg, slackMarkerColumnId: "ColMarker" },
      () => fake.client,
    );
    const result = await actuator.publish({ taskId: "t1", title: "Review" }, ctx);
    expect(result.externalId).toBe("slack:list:L1:item:RecX");
    expect(fake.created).toHaveLength(0);
  });

  test("throws when the token is missing", async () => {
    const fake = fakeClient();
    const actuator = createSlackListsActuator(checkboxCfg, () => fake.client);
    await expect(
      actuator.publish({ taskId: "t", title: "T" }, { secret: async () => null }),
    ).rejects.toThrow(/token/);
  });
});

describe("slack-lists-actuator act", () => {
  test("complete sets the checkbox column to true", async () => {
    const fake = fakeClient();
    const actuator = createSlackListsActuator(checkboxCfg, () => fake.client);
    await actuator.act("slack:list:L1:item:Rec5", { kind: "complete" }, ctx);
    expect(fake.updates).toEqual([
      { rowId: "Rec5", field: { column_id: "ColDone", checkbox: true } },
    ]);
  });

  test("reopen sets the checkbox column to false", async () => {
    const fake = fakeClient();
    const actuator = createSlackListsActuator(checkboxCfg, () => fake.client);
    await actuator.act("slack:list:L1:item:Rec5", { kind: "reopen" }, ctx);
    expect(fake.updates[0]?.field).toEqual({ column_id: "ColDone", checkbox: false });
  });

  test("complete sets the status select when no checkbox column", async () => {
    const fake = fakeClient();
    const actuator = createSlackListsActuator(statusCfg, () => fake.client);
    await actuator.act("slack:list:L1:item:Rec5", { kind: "complete" }, ctx);
    expect(fake.updates[0]?.field).toEqual({ column_id: "ColStatus", select: ["opt_done"] });
  });

  test("complete with no status mapping throws a descriptive error", async () => {
    const fake = fakeClient();
    const actuator = createSlackListsActuator(
      { list: "L1", slackTitleColumnId: "ColTitle" },
      () => fake.client,
    );
    await expect(
      actuator.act("slack:list:L1:item:Rec5", { kind: "complete" }, ctx),
    ).rejects.toThrow(/slackCheckboxColumnId|slackStatusColumnId/);
  });

  test("drop sets the dropped status option when configured", async () => {
    const fake = fakeClient();
    const actuator = createSlackListsActuator(
      { ...statusCfg, slackDroppedOptionId: "opt_dropped" },
      () => fake.client,
    );
    await actuator.act("slack:list:L1:item:Rec5", { kind: "drop" }, ctx);
    expect(fake.updates[0]?.field).toEqual({ column_id: "ColStatus", select: ["opt_dropped"] });
  });

  test("drop without a dropped option is a no-op + warn (does not throw)", async () => {
    const fake = fakeClient();
    const warnings: string[] = [];
    const actuator = createSlackListsActuator(checkboxCfg, () => fake.client);
    await actuator.act(
      "slack:list:L1:item:Rec5",
      { kind: "drop" },
      {
        secret: async () => "xoxb-token",
        onWarn: (m) => warnings.push(m),
      },
    );
    expect(fake.updates).toHaveLength(0);
    expect(warnings[0]).toMatch(/drop/);
  });

  test("comment is unsupported", async () => {
    const fake = fakeClient();
    const actuator = createSlackListsActuator(checkboxCfg, () => fake.client);
    await expect(
      actuator.act("slack:list:L1:item:Rec5", { kind: "comment", body: "x" }, ctx),
    ).rejects.toThrow(/comment is not supported/);
  });
});

describe("parseSlackItemExternalId", () => {
  test("parses listId + rowId", () => {
    expect(parseSlackItemExternalId("slack:list:L1:item:Rec9")).toEqual({
      listId: "L1",
      rowId: "Rec9",
    });
  });
  test("does not mis-parse a read-connector slack message id", () => {
    expect(() => parseSlackItemExternalId("slack:T123:C456:1700000000.000100")).toThrow();
  });
});
