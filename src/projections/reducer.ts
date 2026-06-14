/**
 * Reducers: fold domain events into projection tables (ADR-0002).
 *
 * Each event is applied to the SQLite projections via raw upserts. The same
 * `applyEvent` path is used both for live appends and for full replay, which
 * is what makes rebuild produce identical projections (idempotent per event:
 * applying the same event sequence yields the same rows).
 *
 * `sources_fts` (FTS5) is kept in sync alongside the `sources` table so search
 * (FR-RET-1) reflects the latest body.
 */
import type { Database } from "bun:sqlite";
import type { DomainEvent } from "../events/types.ts";

/** Replace the FTS row for a source (delete-then-insert keeps it consistent). */
function syncSourceFts(sqlite: Database, externalId: string, body: string): void {
  sqlite.query("DELETE FROM sources_fts WHERE external_id = ?").run(externalId);
  sqlite.query("INSERT INTO sources_fts (external_id, body) VALUES (?, ?)").run(externalId, body);
}

/** Record a provenance link if it does not already exist. */
function upsertLink(
  sqlite: Database,
  link: { fromKind: string; fromId: string; toKind: string; toId: string; relation: string },
): void {
  const existing = sqlite
    .query<{ id: number }, [string, string, string, string, string]>(
      `SELECT id FROM links
       WHERE from_kind = ? AND from_id = ? AND to_kind = ? AND to_id = ? AND relation = ?`,
    )
    .get(link.fromKind, link.fromId, link.toKind, link.toId, link.relation);
  if (existing) return;
  sqlite
    .query(
      `INSERT INTO links (from_kind, from_id, to_kind, to_id, relation)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(link.fromKind, link.fromId, link.toKind, link.toId, link.relation);
}

/** Apply a single event to the projections. Idempotent under replay. */
export function applyEvent(sqlite: Database, event: DomainEvent): void {
  switch (event.type) {
    case "SourceObserved": {
      sqlite
        .query(
          `INSERT INTO sources (external_id, source_type, body, fingerprint, observed_at, meta)
           VALUES ($id, $type, $body, $fp, $obs, $meta)
           ON CONFLICT(external_id) DO UPDATE SET
             source_type = excluded.source_type,
             body        = excluded.body,
             fingerprint = excluded.fingerprint,
             observed_at = excluded.observed_at,
             meta        = excluded.meta`,
        )
        .run({
          $id: event.externalId,
          $type: event.sourceType,
          $body: event.body,
          $fp: event.fingerprint,
          $obs: event.observedAt,
          $meta: JSON.stringify(event.meta),
        });
      syncSourceFts(sqlite, event.externalId, event.body);
      return;
    }
    case "SourceBodyUpdated": {
      // Update body/fingerprint/observed_at/meta; leaves source_type untouched.
      // A SourceBodyUpdated without a prior SourceObserved is a no-op: we must
      // NOT create an orphan FTS row with no backing `sources` row, so the FTS
      // sync is gated on the update having actually matched a source.
      const changes = sqlite
        .query(
          `UPDATE sources SET body = $body, fingerprint = $fp, observed_at = $obs, meta = $meta
           WHERE external_id = $id`,
        )
        .run({
          $id: event.externalId,
          $body: event.body,
          $fp: event.fingerprint,
          $obs: event.observedAt,
          $meta: JSON.stringify(event.meta),
        });
      if (changes.changes > 0) {
        syncSourceFts(sqlite, event.externalId, event.body);
      }
      return;
    }
    case "ConnectorSyncCompleted": {
      // No projection row of its own; provenance/cursor live in the event log.
      return;
    }
    case "TaskProposed": {
      sqlite
        .query(
          `INSERT INTO tasks (id, title, state, created_at, updated_at)
           VALUES ($id, $title, 'proposed', $ts, $ts)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title,
             updated_at = excluded.updated_at`,
        )
        .run({ $id: event.taskId, $title: event.title, $ts: event.recordedAt });
      for (const sourceId of event.sourceExternalIds) {
        upsertLink(sqlite, {
          fromKind: "task",
          fromId: event.taskId,
          toKind: "source",
          toId: sourceId,
          relation: "derived_from",
        });
      }
      return;
    }
    case "TaskApplied": {
      sqlite
        .query(
          `INSERT INTO tasks (id, title, state, created_at, updated_at)
           VALUES ($id, '', $state, $ts, $ts)
           ON CONFLICT(id) DO UPDATE SET
             state = excluded.state,
             updated_at = excluded.updated_at`,
        )
        .run({ $id: event.taskId, $state: event.state, $ts: event.recordedAt });
      return;
    }
    case "DecisionRecorded": {
      sqlite
        .query(
          `INSERT INTO decisions (id, title, rationale, recorded_at)
           VALUES ($id, $title, $rationale, $ts)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title,
             rationale = excluded.rationale,
             recorded_at = excluded.recorded_at`,
        )
        .run({
          $id: event.decisionId,
          $title: event.title,
          $rationale: event.rationale,
          $ts: event.recordedAt,
        });
      for (const sourceId of event.sourceExternalIds) {
        upsertLink(sqlite, {
          fromKind: "decision",
          fromId: event.decisionId,
          toKind: "source",
          toId: sourceId,
          relation: "derived_from",
        });
      }
      return;
    }
    case "ReplyDraftProposed": {
      // Reply drafts are provenance links to the replied-to source; the draft
      // body itself stays in the event log (HITL — user sends manually).
      upsertLink(sqlite, {
        fromKind: "reply_draft",
        fromId: event.draftId,
        toKind: "source",
        toId: event.replyToExternalId,
        relation: "replies_to",
      });
      return;
    }
    case "InboxItemTriaged": {
      sqlite
        .query(
          `INSERT INTO inbox (id, source_external_id, state, updated_at)
           VALUES ($id, $src, $state, $ts)
           ON CONFLICT(id) DO UPDATE SET
             source_external_id = excluded.source_external_id,
             state = excluded.state,
             updated_at = excluded.updated_at`,
        )
        .run({
          $id: event.inboxId,
          $src: event.sourceExternalId,
          $state: event.state,
          $ts: event.recordedAt,
        });
      upsertLink(sqlite, {
        fromKind: "inbox",
        fromId: event.inboxId,
        toKind: "source",
        toId: event.sourceExternalId,
        relation: "references",
      });
      return;
    }
    default: {
      // Exhaustiveness guard: a new event type must be handled above.
      const _exhaustive: never = event;
      throw new Error(`unhandled event type: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/** Apply a sequence of events in order. */
export function applyEvents(sqlite: Database, events: Iterable<DomainEvent>): void {
  for (const event of events) applyEvent(sqlite, event);
}
