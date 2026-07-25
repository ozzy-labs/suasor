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
import { insertEventRow, readAllEventRows, streamAllEventRows } from "../db/events-table.ts";
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

/**
 * Stream every event in deterministic replay (`seq` ascending) order, parsing
 * and validating one row at a time (Issue #498 / ADR-0047 決定 4).
 *
 * Same validation as {@link readAllEvents} — the difference is only that the
 * log is never held in memory all at once, so replay cost is O(1) in rows
 * rather than O(log size).
 */
export function* streamAllEvents(sqlite: Database): Generator<DomainEvent> {
  for (const row of streamAllEventRows(sqlite)) {
    const parsed: unknown = JSON.parse(row.payload);
    yield DomainEventSchema.parse(parsed);
  }
}

/** Read every event in deterministic replay (`seq` ascending) order. */
export function readAllEvents(sqlite: Database): DomainEvent[] {
  return readAllEventRows(sqlite).map((row) => {
    const parsed: unknown = JSON.parse(row.payload);
    // Re-validate on read so corrupt/old rows surface explicitly during replay.
    return DomainEventSchema.parse(parsed);
  });
}
