/**
 * DB module: connection, append-only event store, and projection service.
 *
 * `Store` is the thin service layer that ties the event store (ADR-0002) to the
 * projection reducers: `record` appends an event AND applies it live so reads
 * are immediately consistent, while `rebuild` reconstructs projections from the
 * full event log. Both go through the same reducer, guaranteeing rebuild
 * idempotence (FR-MNT-1).
 */
import { appendEvent } from "../events/store.ts";
import type { DomainEvent, NewEvent } from "../events/types.ts";
import {
  type RebuildOptions,
  type RebuildResult,
  rebuildProjections,
} from "../projections/rebuild.ts";
import { applyEvent } from "../projections/reducer.ts";
import { type OpenOptions, openDatabase, type SuasorDb } from "./connection.ts";

export {
  DEFAULT_EMBEDDING_DIM,
  DEFAULT_VEC_TABLE,
  initSchema,
  initVecTable,
  loadVecExtension,
  type OpenOptions,
  openDatabase,
  readVecDim,
  type SuasorDb,
} from "./connection.ts";
export { countEventRows, createEventsTable, readAllEventRows } from "./events-table.ts";
export * as schema from "./schema.ts";
export {
  type EventTypeCount,
  eventTypeBreakdown,
  formatBytes,
  type ProjectionCount,
  type StoreInfo,
  storeInfo,
} from "./store-info.ts";

/** Service binding an open database to event append + projection maintenance. */
export class Store {
  constructor(private readonly db: SuasorDb) {}

  /** Open a database and return a `Store` over it. */
  static open(options: OpenOptions): Store {
    return new Store(openDatabase(options));
  }

  /** Underlying connection (raw SQL / Drizzle access). */
  get connection(): SuasorDb {
    return this.db;
  }

  /**
   * Append an event to the store and apply it to the projections live.
   * Atomic per event (append + apply in one transaction).
   */
  record(event: NewEvent, now: Date = new Date()): DomainEvent {
    const tx = this.db.sqlite.transaction(() => {
      const persisted = appendEvent(this.db.sqlite, event, now);
      applyEvent(this.db.sqlite, persisted);
      return persisted;
    });
    return tx();
  }

  /** Rebuild all projections by replaying the event log (FR-MNT-1). */
  rebuild(options: RebuildOptions = {}): RebuildResult {
    return rebuildProjections(this.db.sqlite, options);
  }

  close(): void {
    this.db.close();
  }
}
