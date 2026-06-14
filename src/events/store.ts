/**
 * Event store API (append + replay).
 *
 * Wraps the raw-SQL events table (src/db/events-table.ts) with Zod validation
 * and envelope assignment. The append path assigns `id` (ULID-like) and
 * `recordedAt`, validates against the discriminated union, and persists the
 * full event as JSON. Replay reads events back in `seq` order, re-validated,
 * for deterministic projection rebuilds (ADR-0002).
 */
import type { Database } from "bun:sqlite";
import { insertEventRow, readAllEventRows } from "../db/events-table.ts";
import { newEventId } from "./id.ts";
import {
  type DomainEvent,
  DomainEvent as DomainEventSchema,
  EVENT_SCHEMA_VERSION,
  type NewEvent,
} from "./types.ts";

/**
 * Append a new event. Assigns `id` and `recordedAt`, fills `schemaVersion`,
 * validates the full event, and persists it. Returns the persisted event.
 *
 * @throws {z.ZodError} when the event fails validation (caller-supplied bug).
 */
export function appendEvent(
  sqlite: Database,
  event: NewEvent,
  now: Date = new Date(),
): DomainEvent {
  const id = newEventId(now.getTime());
  const recordedAt = now.toISOString();
  // Validate the fully-formed event (envelope + payload) before persisting.
  const validated = DomainEventSchema.parse({
    schemaVersion: EVENT_SCHEMA_VERSION,
    ...event,
    id,
    recordedAt,
  });
  insertEventRow(sqlite, {
    id: validated.id,
    type: validated.type,
    schemaVersion: validated.schemaVersion,
    recordedAt: validated.recordedAt,
    payload: JSON.stringify(validated),
  });
  return validated;
}

/** Read every event in deterministic replay (`seq` ascending) order. */
export function readAllEvents(sqlite: Database): DomainEvent[] {
  return readAllEventRows(sqlite).map((row) => {
    const parsed: unknown = JSON.parse(row.payload);
    // Re-validate on read so corrupt/old rows surface explicitly during replay.
    return DomainEventSchema.parse(parsed);
  });
}
