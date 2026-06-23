import { describe, expect, test } from "bun:test";
import type { SourceRecord, SyncContext } from "../../src/connectors/contract.ts";
import {
  createSlackConnector,
  listItemToRecord,
  type SlackClientLike,
  type SlackListItem,
} from "../../src/connectors/slack.ts";

/** A SyncContext with a token + collected warnings. */
function ctx(warnings: string[] = []): SyncContext {
  return { cursor: null, secret: async () => "xoxb-token", onWarn: (m) => warnings.push(m) };
}

/** A fake Slack client exposing only the List read surface. */
function fakeClient(pages: Array<{ items: SlackListItem[]; next?: string }>): SlackClientLike {
  let i = 0;
  return {
    conversations: {
      history: async () => ({ messages: [] }),
      replies: async () => ({ messages: [] }),
    },
    slackListsItems: async () => {
      const page = pages[i] ?? { items: [] };
      i += 1;
      return {
        items: page.items,
        ...(page.next ? { response_metadata: { next_cursor: page.next } } : {}),
      };
    },
  };
}

async function collect(it: AsyncIterable<SourceRecord>): Promise<SourceRecord[]> {
  const out: SourceRecord[] = [];
  for await (const r of it) out.push(r);
  return out;
}

describe("slack List ingestion (ADR-0036 §6 read-back)", () => {
  test("listItemToRecord mints the actuator's externalId + raw cells + cell fingerprint", () => {
    const rec = listItemToRecord(
      "L1",
      {
        id: "Rec5",
        fields: [
          { column_id: "C1", text: "Review" },
          { column_id: "C2", checkbox: true },
        ],
      },
      "2026-06-23T00:00:00.000Z",
    );
    expect(rec.externalId).toBe("slack:list:L1:item:Rec5"); // == actuator publish id
    expect(rec.sourceType).toBe("slack_list_item");
    expect(rec.body).toBe("Review");
    expect(rec.meta.cells).toEqual([
      { column_id: "C1", text: "Review" },
      { column_id: "C2", checkbox: true },
    ]);
    expect(rec.fingerprint).toContain("checkbox"); // cell state in the delta signal
  });

  test("the connector ingests configured lists' items, paginated", async () => {
    const connector = createSlackConnector(
      { lists: ["L1"], channels: [] },
      {
        clientFactory: () =>
          fakeClient([
            {
              items: [{ id: "Rec1", fields: [{ column_id: "C2", checkbox: false }] }],
              next: "cur2",
            },
            { items: [{ id: "Rec2", fields: [{ column_id: "C2", checkbox: true }] }] },
          ]),
      },
    );
    const records = await collect(connector.sync(ctx()));
    expect(records.map((r) => r.externalId)).toEqual([
      "slack:list:L1:item:Rec1",
      "slack:list:L1:item:Rec2",
    ]);
    expect(records.every((r) => r.sourceType === "slack_list_item")).toBe(true);
  });

  test("no lists configured → no list ingestion (back-compat)", async () => {
    const connector = createSlackConnector(
      { channels: [] },
      { clientFactory: () => fakeClient([]) },
    );
    const records = await collect(connector.sync(ctx()));
    expect(records).toHaveLength(0);
  });
});
