/** Events module: domain event types + append-only store (ADR-0002). */
export { newEventId } from "./id.ts";
export { appendEvent, readAllEvents } from "./store.ts";
export {
  ConnectorSyncCompleted,
  DecisionRecorded,
  DomainEvent,
  DraftExported,
  EVENT_SCHEMA_VERSION,
  EVENT_TYPES,
  type EventType,
  InboxItemTriaged,
  type NewEvent,
  ReplyDraftProposed,
  SourceBodyUpdated,
  SourceObserved,
  TaskApplied,
  TaskProposed,
} from "./types.ts";
