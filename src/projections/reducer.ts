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

/**
 * Relation label for human/agent-created manual links (ADR-0018 追補 / #90),
 * distinct from the reducer-derived provenance edges (`derived_from` /
 * `replies_to` / `references`). Manual links carry a stable `link_id`.
 */
export const MANUAL_LINK_RELATION = "manual_link";

/** Record a (derived) provenance link if it does not already exist. */
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

/**
 * Flip any `pending` proposal whose target entity id matches `entityId` to
 * `applied`. Called when propose.apply appends the entity event (TaskProposed /
 * DecisionRecorded / ReplyDraftProposed / InboxItemTriaged), so the ledger
 * reflects approval without the entity events needing to carry a candidateId.
 * Idempotent: re-running over an already-`applied` proposal is a no-op (the
 * WHERE state = 'pending' guard), and an entity with no proposal row touches
 * nothing (direct task.create etc. legitimately has no candidate).
 */
function markProposalApplied(sqlite: Database, entityId: string, ts: string): void {
  sqlite
    .query(
      "UPDATE proposals SET state = 'applied', updated_at = ? WHERE entity_id = ? AND state = 'pending'",
    )
    .run(ts, entityId);
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
      markProposalApplied(sqlite, event.taskId, event.recordedAt);
      return;
    }
    case "TaskApplied": {
      // Apply only advances an already-proposed task's lifecycle state. Like
      // SourceBodyUpdated, it must NOT fabricate a row (a titleless task) when no
      // prior TaskProposed exists — so a TaskApplied with no matching task is a
      // no-op under replay rather than inserting an empty-title placeholder.
      sqlite
        .query("UPDATE tasks SET state = $state, updated_at = $ts WHERE id = $id")
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
      markProposalApplied(sqlite, event.decisionId, event.recordedAt);
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
      markProposalApplied(sqlite, event.draftId, event.recordedAt);
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
      markProposalApplied(sqlite, event.inboxId, event.recordedAt);
      return;
    }
    case "ProposalGenerated": {
      // Ledger upsert: a freshly generated candidate enters as `pending`. Replay-
      // safe — ON CONFLICT preserves an already-decided (applied/rejected) state
      // so a later regenerate of the same candidate does not resurrect it to
      // pending, while still refreshing the descriptive columns.
      sqlite
        .query(
          `INSERT INTO proposals
             (candidate_id, mode, kind, entity_id, summary, state, reason, created_at, updated_at)
           VALUES ($cid, $mode, $kind, $eid, $summary, 'pending', '', $ts, $ts)
           ON CONFLICT(candidate_id) DO UPDATE SET
             mode       = excluded.mode,
             kind       = excluded.kind,
             entity_id  = excluded.entity_id,
             summary    = excluded.summary,
             updated_at = excluded.updated_at`,
        )
        .run({
          $cid: event.candidateId,
          $mode: event.mode,
          $kind: event.kind,
          $eid: event.entityId,
          $summary: event.summary,
          $ts: event.recordedAt,
        });
      return;
    }
    case "ProposalRejected": {
      // Reject only acts on a still-pending candidate (an applied proposal stays
      // applied — the entity is already persisted). No-op when no such row.
      sqlite
        .query(
          "UPDATE proposals SET state = 'rejected', reason = $reason, updated_at = $ts WHERE candidate_id = $cid AND state = 'pending'",
        )
        .run({ $cid: event.candidateId, $reason: event.reason, $ts: event.recordedAt });
      return;
    }
    case "LinkAdded": {
      // A manual link (ADR-0018 追補 / #90) carries its own stable link_id so it
      // can be removed by id and replayed deterministically. Idempotent: a second
      // LinkAdded with the same link_id is a no-op (the row already exists).
      const existing = sqlite
        .query<{ id: number }, [string]>("SELECT id FROM links WHERE link_id = ?")
        .get(event.linkId);
      if (existing) return;
      sqlite
        .query(
          `INSERT INTO links (from_kind, from_id, to_kind, to_id, relation, link_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.fromKind,
          event.fromId,
          event.toKind,
          event.toId,
          MANUAL_LINK_RELATION,
          event.linkId,
        );
      return;
    }
    case "LinkRemoved": {
      // Delete the manual link by its stable id. Removing an absent link is a
      // no-op under replay (idempotent) — the write tool guards against removing
      // a non-existent link at the boundary so the host can surface the error.
      sqlite.query("DELETE FROM links WHERE link_id = ?").run(event.linkId);
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
