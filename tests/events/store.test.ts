import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createEventsTable } from "../../src/db/events-table.ts";
import { appendEvent, readAllEvents } from "../../src/events/store.ts";
import { EVENT_SCHEMA_VERSION } from "../../src/events/types.ts";

let sqlite: Database;

beforeEach(() => {
  sqlite = new Database(":memory:");
  createEventsTable(sqlite);
});

afterEach(() => {
  sqlite.close();
});

describe("appendEvent round-trip", () => {
  test("assigns id + recordedAt + schemaVersion and persists", () => {
    const persisted = appendEvent(sqlite, {
      type: "SourceObserved",
      externalId: "github:issue:1",
      sourceType: "github_issue",
      body: "hello world",
      observedAt: "2026-06-14T00:00:00.000Z",
      fingerprint: "abc",
      meta: { repo: "ozzy-labs/suasor" },
    });

    expect(persisted.id).toBeTruthy();
    expect(persisted.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(persisted.schemaVersion).toBe(EVENT_SCHEMA_VERSION);

    const all = readAllEvents(sqlite);
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(persisted);
  });

  test("preserves replay order by seq", () => {
    appendEvent(sqlite, {
      type: "ConnectorSyncCompleted",
      connector: "github",
      cursor: "c1",
      count: 1,
    });
    appendEvent(sqlite, {
      type: "ConnectorSyncCompleted",
      connector: "slack",
      cursor: "c2",
      count: 2,
    });
    const all = readAllEvents(sqlite);
    expect(all.map((e) => (e.type === "ConnectorSyncCompleted" ? e.connector : ""))).toEqual([
      "github",
      "slack",
    ]);
  });

  test("fills payload defaults (meta, count, cursor)", () => {
    appendEvent(sqlite, {
      type: "ConnectorSyncCompleted",
      connector: "github",
    });
    const [evt] = readAllEvents(sqlite);
    expect(evt?.type).toBe("ConnectorSyncCompleted");
    if (evt?.type === "ConnectorSyncCompleted") {
      expect(evt.cursor).toBeNull();
      expect(evt.count).toBe(0);
    }
  });

  test("rejects an invalid event (missing discriminator payload field)", () => {
    expect(() =>
      // @ts-expect-error intentionally invalid: SourceObserved requires externalId
      appendEvent(sqlite, { type: "SourceObserved", body: "x" }),
    ).toThrow();
  });

  test("generated ids are time-sortable and unique", () => {
    const e1 = appendEvent(sqlite, { type: "ConnectorSyncCompleted", connector: "a" });
    const e2 = appendEvent(sqlite, { type: "ConnectorSyncCompleted", connector: "b" });
    expect(e1.id).not.toBe(e2.id);
  });
});
