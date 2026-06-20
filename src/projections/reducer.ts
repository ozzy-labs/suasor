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
import { identityKey } from "./person.ts";

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

/**
 * Ensure a `persons` row exists (ADR-0022). Inserts with a zero identity count
 * (the caller adjusts it as identities attach), preserving an existing row's
 * created_at and only advancing updated_at / a non-empty display name.
 */
function ensurePerson(sqlite: Database, personId: string, displayName: string, ts: string): void {
  sqlite
    .query(
      `INSERT INTO persons (id, display_name, identity_count, created_at, updated_at)
       VALUES ($id, $name, 0, $ts, $ts)
       ON CONFLICT(id) DO UPDATE SET
         display_name = CASE WHEN excluded.display_name <> '' THEN excluded.display_name
                             ELSE persons.display_name END,
         updated_at   = excluded.updated_at`,
    )
    .run({ $id: personId, $name: displayName, $ts: ts });
}

/** Recompute a person's identity_count from the identities table (replay-safe). */
function refreshIdentityCount(sqlite: Database, personId: string, ts: string): void {
  sqlite
    .query(
      `UPDATE persons SET
         identity_count = (SELECT COUNT(*) FROM person_identities WHERE person_id = $id),
         updated_at = $ts
       WHERE id = $id`,
    )
    .run({ $id: personId, $ts: ts });
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
    case "SourceForgotten": {
      // Forget (ADR-0026): delete the event-derived projection rows so a
      // `projections rebuild` (truncate + replay) keeps the source absent —
      // the redacted SourceObserved re-inserts an empty row, then this DELETE
      // removes it again (replay-stable). The non-event sidecar substrate
      // (vec0 / *_meta) is purged imperatively by the source.forget service.
      sqlite.query("DELETE FROM sources WHERE external_id = ?").run(event.externalId);
      sqlite.query("DELETE FROM sources_fts WHERE external_id = ?").run(event.externalId);
      return;
    }
    case "ConnectorSyncCompleted": {
      // No projection row of its own; provenance/cursor live in the event log.
      return;
    }
    case "SyncRunStarted": {
      // Begin the connector's latest run (ADR-0033): upsert by connector with the
      // new run's id / start time and a `running` status, clearing the prior run's
      // terminal fields (ended_at / duration / last_error) so a still-running row
      // doesn't show stale outcome data. The matching SyncRunEnded confirms them.
      sqlite
        .query(
          `INSERT INTO sync_runs
             (connector, run_id, started_at, ended_at, status,
              observed, updated, unchanged, duration_ms, last_error)
           VALUES ($conn, $run, $started, NULL, 'running', 0, 0, 0, NULL, NULL)
           ON CONFLICT(connector) DO UPDATE SET
             run_id      = excluded.run_id,
             started_at  = excluded.started_at,
             ended_at    = NULL,
             status      = 'running',
             observed    = 0,
             updated     = 0,
             unchanged   = 0,
             duration_ms = NULL,
             last_error  = NULL`,
        )
        .run({ $conn: event.connector, $run: event.runId, $started: event.startedAt });
      return;
    }
    case "SyncRunEnded": {
      // Confirm the connector's latest run (ADR-0033). Upsert keyed by connector so
      // replay is order-stable even if a SyncRunStarted is somehow absent (the row
      // is created with recordedAt as a best-effort started_at). Only overwrite the
      // running row when this ended event belongs to its run, OR the row is already
      // terminal (idempotent re-apply): guarded by matching run_id, else still
      // record it as the latest (most events arrive started→ended in order).
      sqlite
        .query(
          `INSERT INTO sync_runs
             (connector, run_id, started_at, ended_at, status,
              observed, updated, unchanged, duration_ms, last_error)
           VALUES ($conn, $run, $ended, $ended, $status,
                   $observed, $updated, $unchanged, $duration, $error)
           ON CONFLICT(connector) DO UPDATE SET
             run_id      = excluded.run_id,
             ended_at    = excluded.ended_at,
             status      = excluded.status,
             observed    = excluded.observed,
             updated     = excluded.updated,
             unchanged   = excluded.unchanged,
             duration_ms = excluded.duration_ms,
             last_error  = excluded.last_error`,
        )
        .run({
          $conn: event.connector,
          $run: event.runId,
          $ended: event.recordedAt,
          $status: event.status,
          $observed: event.observed,
          $updated: event.updated,
          $unchanged: event.unchanged,
          $duration: event.durationMs,
          $error: event.error ?? null,
        });
      return;
    }
    case "TaskProposed": {
      // Scheduling fields (ADR-0028): dueDate / priority are folded onto the row
      // (event-payload values, time-independent — safe to store; overdue is the
      // only current-time-dependent bit and is derived at read time, not here).
      // On re-proposal they refresh alongside the title.
      sqlite
        .query(
          `INSERT INTO tasks (id, title, state, due_date, priority, created_at, updated_at)
           VALUES ($id, $title, 'proposed', $due, $priority, $ts, $ts)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title,
             due_date = excluded.due_date,
             priority = excluded.priority,
             updated_at = excluded.updated_at`,
        )
        .run({
          $id: event.taskId,
          $title: event.title,
          $due: event.dueDate,
          $priority: event.priority,
          $ts: event.recordedAt,
        });
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
      //
      // Scheduling fields (ADR-0028): a non-null dueDate / priority on apply
      // (re)sets the column; a null value leaves the proposed value untouched
      // (COALESCE keeps the existing column when the update carries null). This
      // lets task.update advance state without clobbering an existing due date.
      sqlite
        .query(
          `UPDATE tasks SET
             state = $state,
             due_date = COALESCE($due, due_date),
             priority = COALESCE($priority, priority),
             updated_at = $ts
           WHERE id = $id`,
        )
        .run({
          $id: event.taskId,
          $state: event.state,
          $due: event.dueDate,
          $priority: event.priority,
          $ts: event.recordedAt,
        });
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
    case "DraftExported": {
      // No projection: a body-less audit record that an export happened (ADR-0025).
      // The exported file is a side effect, not re-created on replay (like
      // ConnectorSyncCompleted, the provenance lives in the event log alone).
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
    case "PersonIdentityObserved": {
      // First observation of a (connector, handle) pair binds it to its
      // content-derived person (1 handle = 1 person, ADR-0022). Idempotent:
      // re-observing an existing identity does NOT overwrite its person_id, so a
      // prior merge/split that moved the identity is preserved across replay/sync.
      const key = identityKey(event.connector, event.handle);
      const name = event.displayName ?? "";
      const existing = sqlite
        .query<{ person_id: string }, [string]>(
          "SELECT person_id FROM person_identities WHERE identity_key = ?",
        )
        .get(key);
      if (existing === null) {
        ensurePerson(sqlite, event.personId, name, event.recordedAt);
        sqlite
          .query(
            `INSERT INTO person_identities
               (identity_key, person_id, connector, handle, display_name, observed_at)
             VALUES ($key, $pid, $conn, $handle, $name, $ts)`,
          )
          .run({
            $key: key,
            $pid: event.personId,
            $conn: event.connector,
            $handle: event.handle,
            $name: name,
            $ts: event.recordedAt,
          });
        refreshIdentityCount(sqlite, event.personId, event.recordedAt);
      } else if (name !== "") {
        // Keep the latest known display name on both the identity and its
        // (current) person without re-pointing the identity.
        sqlite
          .query("UPDATE person_identities SET display_name = $name WHERE identity_key = $key")
          .run({ $name: name, $key: key });
        sqlite
          .query(
            `UPDATE persons SET display_name = $name, updated_at = $ts
             WHERE id = $pid`,
          )
          .run({ $name: name, $ts: event.recordedAt, $pid: existing.person_id });
      }
      return;
    }
    case "PersonsMerged": {
      // Reassign every identity of the source person to the target, then refresh
      // both counts. Replay-safe: a re-applied merge finds no source identities
      // and is a no-op. The emptied source person row is kept (audit) but elided
      // from person.list by its zero identity_count.
      if (event.sourcePersonId === event.targetPersonId) return;
      ensurePerson(sqlite, event.targetPersonId, "", event.recordedAt);
      sqlite
        .query("UPDATE person_identities SET person_id = $tgt WHERE person_id = $src")
        .run({ $tgt: event.targetPersonId, $src: event.sourcePersonId });
      refreshIdentityCount(sqlite, event.sourcePersonId, event.recordedAt);
      refreshIdentityCount(sqlite, event.targetPersonId, event.recordedAt);
      return;
    }
    case "PersonSplit": {
      // Move a single identity to another person (inverse of merge). No-op when
      // the identity does not exist or already resolves to the new person.
      const key = identityKey(event.connector, event.handle);
      const row = sqlite
        .query<{ person_id: string }, [string]>(
          "SELECT person_id FROM person_identities WHERE identity_key = ?",
        )
        .get(key);
      if (row === null || row.person_id === event.newPersonId) return;
      const previousPersonId = row.person_id;
      ensurePerson(sqlite, event.newPersonId, "", event.recordedAt);
      sqlite
        .query("UPDATE person_identities SET person_id = $pid WHERE identity_key = $key")
        .run({ $pid: event.newPersonId, $key: key });
      refreshIdentityCount(sqlite, previousPersonId, event.recordedAt);
      refreshIdentityCount(sqlite, event.newPersonId, event.recordedAt);
      return;
    }
    case "CommitmentOpened": {
      // A confirmed commitment enters the ledger as `open` (ADR-0021). ON
      // CONFLICT refreshes the descriptive columns but leaves `state` untouched
      // so a re-extraction of the same commitment does not resurrect a resolved/
      // dismissed one to open (replay-safe, content-derived id).
      sqlite
        .query(
          `INSERT INTO commitments
             (id, title, direction, state, due_date, person, created_at, updated_at)
           VALUES ($id, $title, $dir, 'open', $due, $person, $ts, $ts)
           ON CONFLICT(id) DO UPDATE SET
             title      = excluded.title,
             direction  = excluded.direction,
             due_date   = excluded.due_date,
             person     = excluded.person,
             updated_at = excluded.updated_at`,
        )
        .run({
          $id: event.commitmentId,
          $title: event.title,
          $dir: event.direction,
          $due: event.dueDate,
          $person: event.person,
          $ts: event.recordedAt,
        });
      for (const sourceId of event.sourceExternalIds) {
        upsertLink(sqlite, {
          fromKind: "commitment",
          fromId: event.commitmentId,
          toKind: "source",
          toId: sourceId,
          relation: "derived_from",
        });
      }
      // A commitment extracted via the commitment_scan propose mode has a pending
      // proposals-ledger row (persistProposals); flip it to applied by entity_id,
      // mirroring task/decision/reply_draft/triage so propose.list stays accurate.
      markProposalApplied(sqlite, event.commitmentId, event.recordedAt);
      return;
    }
    case "CommitmentResolved": {
      // Advance an existing commitment to `resolved`. A transition for a missing
      // commitment is a no-op under replay (no row to fabricate), mirroring
      // TaskApplied — the write tool guards invalid transitions at the boundary.
      sqlite
        .query("UPDATE commitments SET state = 'resolved', updated_at = $ts WHERE id = $id")
        .run({ $id: event.commitmentId, $ts: event.recordedAt });
      return;
    }
    case "CommitmentDismissed": {
      sqlite
        .query("UPDATE commitments SET state = 'dismissed', updated_at = $ts WHERE id = $id")
        .run({ $id: event.commitmentId, $ts: event.recordedAt });
      return;
    }
    case "CommitmentReopened": {
      sqlite
        .query("UPDATE commitments SET state = 'open', updated_at = $ts WHERE id = $id")
        .run({ $id: event.commitmentId, $ts: event.recordedAt });
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
