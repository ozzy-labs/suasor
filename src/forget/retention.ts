/**
 * Body retention (ADR-0047 決定 2, Issue #498) — bound storage by dropping the
 * bodies of sources older than a configured age, keeping everything else.
 *
 * **Opt-in and off by default.** Dropping a body removes it from full-text
 * search permanently, and long-tail recall ("あの資料どこ") is the product's
 * core value — so this must never run because nobody chose it. `doctor` makes
 * growth visible (Issue #498 決定 1) precisely so the choice can be made at the
 * right time rather than forced by a default.
 *
 * What it keeps, deliberately: the source row, its metadata, its provenance
 * links, and its embedding. Those are orders of magnitude smaller than the body
 * and are what make a dropped source still findable ("this existed, on this
 * date, from this person, linked to that decision"). The alternative — deleting
 * the row — would turn a bounded store into a store with holes in its history.
 *
 * Mechanism: the same redaction path `source.forget` already uses (ADR-0026
 * R1-1/4/5) — one transaction, `secure_delete` around the writes, and a WAL
 * checkpoint afterwards — because "remove a body from the event log without
 * breaking replay" is exactly the operation this needs, and it is already
 * production-hardened. The event schema is untouched (ADR-0047 決定 3).
 */
import type { Store } from "../db/index.ts";

export interface RetentionInput {
  /** Drop bodies of sources observed more than this many days ago. */
  bodyMaxAgeDays: number;
  /** Report what would be dropped without writing anything. */
  dryRun?: boolean;
}

export interface RetentionResult {
  /** ISO 8601 cutoff — sources observed strictly before this are in scope. */
  cutoff: string;
  /** Sources whose body is older than the cutoff and not already dropped. */
  candidates: number;
  /** Bodies actually dropped (0 on a dry run). */
  dropped: number;
  /** Bytes of body text removed from the `sources` projection. */
  bytesFreed: number;
  /** Whether this was a dry run (nothing was written). */
  dryRun: boolean;
}

/** Sources eligible for a body drop: old enough, still carrying a body. */
interface Candidate {
  external_id: string;
  bytes: number;
}

/**
 * Apply the retention policy.
 *
 * Idempotent: a source whose body was already dropped is not a candidate again
 * (`body_dropped_at` is set), so re-running is a no-op rather than a second
 * pass of writes.
 */
export function applyRetention(
  store: Store,
  input: RetentionInput,
  now: Date = new Date(),
): RetentionResult {
  const { bodyMaxAgeDays, dryRun = false } = input;
  const sqlite = store.connection.sqlite;
  const cutoff = new Date(now.getTime() - bodyMaxAgeDays * 24 * 60 * 60 * 1000).toISOString();

  const candidates = sqlite
    .query<Candidate, [string]>(
      `SELECT external_id, LENGTH(body) AS bytes
         FROM sources
        WHERE observed_at < ? AND body <> '' AND body_dropped_at IS NULL
        ORDER BY observed_at ASC`,
    )
    .all(cutoff);
  const bytesFreed = candidates.reduce((sum, c) => sum + c.bytes, 0);

  if (dryRun || candidates.length === 0) {
    return {
      cutoff,
      candidates: candidates.length,
      dropped: 0,
      bytesFreed: dryRun ? bytesFreed : 0,
      dryRun,
    };
  }

  // Physical erasure (ADR-0026 R1-5, reused): zero the freed pages rather than
  // leaving readable plaintext behind. Restored afterwards — the write
  // amplification is only acceptable for a low-frequency maintenance pass.
  const priorSecureDelete =
    ((sqlite.query("PRAGMA secure_delete").get() as { secure_delete?: number } | null)
      ?.secure_delete ?? 0) !== 0;
  if (!priorSecureDelete) sqlite.exec("PRAGMA secure_delete = ON");
  try {
    const tx = sqlite.transaction(() => {
      for (const { external_id: externalId } of candidates) {
        // 1. Redact the historical bodies. Without this the event log still
        //    holds every version and nothing would actually be reclaimed —
        //    and a rebuild would restore the text we just dropped.
        sqlite
          .query(
            `UPDATE events
                SET payload = json_set(payload, '$.body', '')
              WHERE type IN ('SourceObserved', 'SourceBodyUpdated')
                AND json_extract(payload, '$.externalId') = ?`,
          )
          .run(externalId);
        // 2. Append the audit event; its reducer blanks the row, stamps
        //    `body_dropped_at`, and drops the FTS entry (replay-stable).
        store.record({ type: "SourceBodyDropped", externalId, reason: "retention" }, now);
      }
    });
    tx();
  } finally {
    if (!priorSecureDelete) sqlite.exec("PRAGMA secure_delete = OFF");
  }

  // Flush + truncate the WAL so dropped text does not linger in the sidecar.
  // Must run outside the transaction. No-op on an in-memory / non-WAL database.
  sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");

  return { cutoff, candidates: candidates.length, dropped: candidates.length, bytesFreed, dryRun };
}
