/**
 * Derived-content cascade for `source.forget` (ADR-0026 R1-2).
 *
 * Forgetting a source only removes THAT source's own body from the event log and
 * projection. But at propose/apply time the source text also flowed verbatim into
 * *derived* free-text fields — a task/decision title, a decision rationale, a
 * reply-draft body, a commitment title, and the `ProposalGenerated.summary` in the
 * proposals ledger (which holds a reply_draft's full body, even for a candidate a
 * human later rejected). Forgetting the source alone leaves those quotes behind
 * (critical: core/forget-2), so a "forgotten" source can still be reconstructed
 * from its derived content.
 *
 * This module does two things:
 *   1. {@link enumerateDerived} — lists the derived entities so `source.forget`
 *      can ALWAYS disclose them (disclosure is mandatory, ADR-0026 R1-2). Drawn
 *      from the provenance links (`idx_links_to`) + the proposals ledger
 *      (`ProposalGenerated.sourceExternalIds`, incl. rejected candidates) +
 *      `DraftExported` paths.
 *   2. {@link redactDerived} — on an opt-in cascade, blanks the derived free-text
 *      fields the same replay-safe way the source body is redacted (`json_set` on
 *      the historical event payloads + the matching projection columns), within
 *      the caller's forget transaction. The redaction target fields are limited to
 *      the ADR-0026 R1-2 enumeration (title / rationale / body / summary).
 *
 * Out of scope (disclosed, never touched): `DraftExported` files (they live
 * outside the DB), `VACUUM INTO` backups, OS backups, host conversation history
 * (ADR-0026 Negative).
 */
import type { Database } from "bun:sqlite";

/**
 * Replacement written over redacted derived free-text (ADR-0026 R1-2/3).
 *
 * Non-empty on purpose: the source-body redaction blanks to `""` (its schema
 * allows an empty body), but the derived `title` fields are `z.string().min(1)`,
 * so a redacted event payload must still re-validate on replay (`readAllEvents`
 * re-parses every row through the Zod union). A short marker satisfies `min(1)`
 * and keeps the redaction auditable ("this field held content that was purged").
 */
export const REDACTED_TEXT = "[redacted]";

/** Link `from_kind`s whose derived entity carries a redactable free-text field. */
const REDACTABLE_LINK_KINDS = new Set(["task", "decision", "reply_draft", "commitment"]);

/** A single entity derived from a forgotten source (ADR-0026 R1-2 disclosure). */
export interface DerivedEntity {
  /** Entity kind: task / decision / reply_draft / commitment / inbox / proposal / draft_export. */
  kind: string;
  /**
   * Entity id: the projection/entity id (`taskId` / `decisionId` / `draftId` /
   * `commitmentId` / `inboxId`), the ledger `candidateId` for `proposal`, or the
   * export file path for `draft_export`.
   */
  id: string;
  /** How it ties to the source: derived_from / replies_to / references / proposal / exported. */
  relation: string;
  /**
   * Whether the cascade redacts free-text on this entity. `true` for entities that
   * carry a verbatim quote (task / decision / reply_draft / commitment / proposal
   * summary); `false` for out-of-scope disclosures (`draft_export` — the file is
   * outside the DB, ADR-0026 Negative) and `inbox` (no body-derived free-text).
   */
  redactable: boolean;
}

/**
 * Enumerate every entity derived from `externalId` for disclosure (ADR-0026 R1-2).
 * Pure read — safe to call before or after redaction (it keys off the provenance
 * links + the events' `sourceExternalIds`, neither of which redaction touches).
 */
export function enumerateDerived(sqlite: Database, externalId: string): DerivedEntity[] {
  const out: DerivedEntity[] = [];

  // 1. Provenance links (idx_links_to): task / decision / reply_draft / commitment
  //    / inbox derived-from / reply-to / referencing the forgotten source. Only
  //    reducer-derived edges (link_id IS NULL) — a manual link is user provenance,
  //    not derived content.
  const links = sqlite
    .query<{ from_kind: string; from_id: string; relation: string }, [string]>(
      `SELECT from_kind, from_id, relation FROM links
        WHERE to_kind = 'source' AND to_id = ? AND link_id IS NULL
        ORDER BY from_kind, from_id`,
    )
    .all(externalId);
  for (const l of links) {
    out.push({
      kind: l.from_kind,
      id: l.from_id,
      relation: l.relation,
      redactable: REDACTABLE_LINK_KINDS.has(l.from_kind),
    });
  }

  // 2. Proposals ledger: ProposalGenerated candidates whose provenance includes
  //    the source — INCLUDING rejected ones, whose summary can still hold verbatim
  //    reply-draft text. Read from the event payload since the `proposals`
  //    projection does not store `sourceExternalIds`.
  const proposals = sqlite
    .query<{ candidate_id: string }, [string]>(
      `SELECT DISTINCT json_extract(e.payload, '$.candidateId') AS candidate_id
         FROM events e, json_each(e.payload, '$.sourceExternalIds') je
        WHERE e.type = 'ProposalGenerated' AND je.value = ?
        ORDER BY candidate_id`,
    )
    .all(externalId);
  for (const p of proposals) {
    out.push({ kind: "proposal", id: p.candidate_id, relation: "proposal", redactable: true });
  }

  // 3. DraftExported files — OUT OF SCOPE (the file lives outside the DB, ADR-0026
  //    Negative), but disclosed so the operator knows an exported copy survives.
  const exports = sqlite
    .query<{ path: string }, [string]>(
      `SELECT json_extract(payload, '$.path') AS path FROM events
        WHERE type = 'DraftExported' AND json_extract(payload, '$.sourceExternalId') = ?
        ORDER BY path`,
    )
    .all(externalId);
  for (const ex of exports) {
    out.push({ kind: "draft_export", id: ex.path, relation: "exported", redactable: false });
  }

  return out;
}

/**
 * Cascade-redact the derived free-text of every entity derived from `externalId`
 * (ADR-0026 R1-2). Blanks the event-log payloads (the replay source of truth) AND
 * the matching projection columns (the live read state), so the redaction holds
 * both immediately and across a `projections rebuild`.
 *
 * MUST be called inside the forget transaction (so it is atomic with the body
 * redaction) — it opens no transaction of its own. Idempotent: re-running over
 * already-redacted content is a no-op (`json_set` to the same marker).
 */
export function redactDerived(sqlite: Database, externalId: string, now: Date): void {
  const R = REDACTED_TEXT;
  const ts = now.toISOString();

  // --- Event-log redaction (replay source of truth) ---
  // Match on the event's own `sourceExternalIds` (a correlated json_each), so a
  // derived event that quotes the source is redacted even if its projection row
  // was since deleted. Reply drafts key off `replyToExternalId`.
  sqlite
    .query(
      `UPDATE events SET payload = json_set(payload, '$.title', ?)
        WHERE type = 'TaskProposed'
          AND EXISTS (SELECT 1 FROM json_each(events.payload, '$.sourceExternalIds') je
                       WHERE je.value = ?)`,
    )
    .run(R, externalId);
  sqlite
    .query(
      `UPDATE events SET payload = json_set(payload, '$.title', ?, '$.rationale', ?)
        WHERE type = 'DecisionRecorded'
          AND EXISTS (SELECT 1 FROM json_each(events.payload, '$.sourceExternalIds') je
                       WHERE je.value = ?)`,
    )
    .run(R, R, externalId);
  sqlite
    .query(
      `UPDATE events SET payload = json_set(payload, '$.title', ?)
        WHERE type = 'CommitmentOpened'
          AND EXISTS (SELECT 1 FROM json_each(events.payload, '$.sourceExternalIds') je
                       WHERE je.value = ?)`,
    )
    .run(R, externalId);
  sqlite
    .query(
      `UPDATE events SET payload = json_set(payload, '$.body', ?)
        WHERE type = 'ReplyDraftProposed'
          AND json_extract(payload, '$.replyToExternalId') = ?`,
    )
    .run(R, externalId);
  sqlite
    .query(
      `UPDATE events SET payload = json_set(payload, '$.summary', ?)
        WHERE type = 'ProposalGenerated'
          AND EXISTS (SELECT 1 FROM json_each(events.payload, '$.sourceExternalIds') je
                       WHERE je.value = ?)`,
    )
    .run(R, externalId);

  // --- Projection redaction (live read state) ---
  // Target rows via the provenance links so only entities genuinely derived from
  // the forgotten source are touched. A `projections rebuild` would reproduce the
  // same blanked columns from the redacted events above (replay-stable).
  sqlite
    .query(
      `UPDATE tasks SET title = ?, updated_at = ?
        WHERE id IN (SELECT from_id FROM links
                      WHERE to_kind = 'source' AND to_id = ? AND from_kind = 'task')`,
    )
    .run(R, ts, externalId);
  sqlite
    .query(
      `UPDATE decisions SET title = ?, rationale = ?
        WHERE id IN (SELECT from_id FROM links
                      WHERE to_kind = 'source' AND to_id = ? AND from_kind = 'decision')`,
    )
    .run(R, R, externalId);
  sqlite
    .query(
      `UPDATE commitments SET title = ?, updated_at = ?
        WHERE id IN (SELECT from_id FROM links
                      WHERE to_kind = 'source' AND to_id = ? AND from_kind = 'commitment')`,
    )
    .run(R, ts, externalId);
  // Reply drafts have no projection (links + event only) — the event redaction
  // above is the whole story. Proposals do: blank every candidate summary whose
  // ProposalGenerated references the source.
  sqlite
    .query(
      `UPDATE proposals SET summary = ?, updated_at = ?
        WHERE candidate_id IN (
          SELECT DISTINCT json_extract(e.payload, '$.candidateId')
            FROM events e, json_each(e.payload, '$.sourceExternalIds') je
           WHERE e.type = 'ProposalGenerated' AND je.value = ?)`,
    )
    .run(R, ts, externalId);
}

/**
 * Redact a single proposal candidate's `ProposalGenerated.summary` (ADR-0026
 * R1-3, the reject-time source-of-leak fix). A reply_draft candidate's summary is
 * its full body, so a human-rejected draft must not linger verbatim in the ledger.
 * Blanks the event payload + the `proposals` projection column. Applied
 * independently of forget; no transaction of its own (the caller owns it).
 * Idempotent (`json_set` to the same marker).
 */
export function redactProposalSummary(sqlite: Database, candidateId: string, now: Date): void {
  const R = REDACTED_TEXT;
  sqlite
    .query(
      `UPDATE events SET payload = json_set(payload, '$.summary', ?)
        WHERE type = 'ProposalGenerated'
          AND json_extract(payload, '$.candidateId') = ?`,
    )
    .run(R, candidateId);
  sqlite
    .query("UPDATE proposals SET summary = ?, updated_at = ? WHERE candidate_id = ?")
    .run(R, now.toISOString(), candidateId);
}
