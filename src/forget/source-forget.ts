/**
 * `source.forget` — purge an ingested source locally (ADR-0026).
 *
 * Suasor's "right to be forgotten" path. Forgetting must remove the body from
 * BOTH the projection AND the event log (content-minimization, ADR-0003), so it
 * combines two mechanisms:
 *   1. **redaction** — blank the `body` in the historical SourceObserved /
 *      SourceBodyUpdated event payloads (a controlled, audited exception to the
 *      append-only log, ADR-0026 / ADR-0002). The content leaves the log.
 *   2. **`SourceForgotten` event** — its reducer DELETEs the `sources` /
 *      `sources_fts` rows, so a `projections rebuild` (truncate + replay) keeps
 *      the source absent (the redacted SourceObserved re-inserts an empty row,
 *      then the replayed SourceForgotten deletes it — replay-stable).
 * Non-event sidecar substrate (vec0 + `embeddings_meta` + `extraction_meta`) is
 * deleted imperatively here (it is not rebuilt by replay). HITL (ADR-0004).
 *
 * Idempotent: re-forgetting is a no-op (`already_forgotten`); a never-ingested
 * id is `missing`. Steps are individually idempotent so a retry after a partial
 * failure converges.
 */
import { DEFAULT_VEC_TABLE, VEC_META_TABLE } from "../db/connection.ts";
import type { Store } from "../db/index.ts";

export interface SourceForgetInput {
  externalId: string;
  /** Optional human reason recorded on the audit event. */
  reason?: string;
}

export interface SourceForgetOutput {
  externalId: string;
  /**
   *   - `forgotten`        — content redacted + projection/sidecar purged;
   *   - `already_forgotten`— a prior SourceForgotten exists and no row remains;
   *   - `missing`          — the source was never ingested.
   */
  status: "forgotten" | "already_forgotten" | "missing";
}

/** Count events of given types for a source (via the JSON payload externalId). */
function countEvents(store: Store, externalId: string, types: string[]): number {
  const placeholders = types.map(() => "?").join(", ");
  const row = store.connection.sqlite
    .query<{ n: number }, string[]>(
      `SELECT COUNT(*) AS n FROM events
        WHERE type IN (${placeholders})
          AND json_extract(payload, '$.externalId') = ?`,
    )
    .get(...types, externalId);
  return row?.n ?? 0;
}

/** True when a table exists (vec0 is only present when --vec / embedding is set up). */
function tableExists(store: Store, name: string): boolean {
  return (
    (store.connection.sqlite
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type IN ('table','view') AND name = ?",
      )
      .get(name)?.n ?? 0) > 0
  );
}

/**
 * Forget a source: redact its body from the event log, purge the projection and
 * sidecar substrate, and append a body-less `SourceForgotten` audit event. The
 * host must have human approval first (HITL).
 */
export function sourceForget(
  store: Store,
  input: SourceForgetInput,
  now: Date = new Date(),
): SourceForgetOutput {
  const { externalId, reason } = input;
  const sqlite = store.connection.sqlite;

  const ingested = countEvents(store, externalId, ["SourceObserved", "SourceBodyUpdated"]);
  const forgottenBefore = countEvents(store, externalId, ["SourceForgotten"]);
  const rowExists =
    (sqlite
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM sources WHERE external_id = ?")
      .get(externalId)?.n ?? 0) > 0;

  if (ingested === 0 && forgottenBefore === 0) return { externalId, status: "missing" };
  if (forgottenBefore > 0 && !rowExists) return { externalId, status: "already_forgotten" };

  // 1. Redact the body in the historical source events (ADR-0026 exception).
  sqlite
    .query(
      `UPDATE events
          SET payload = json_set(payload, '$.body', '')
        WHERE type IN ('SourceObserved', 'SourceBodyUpdated')
          AND json_extract(payload, '$.externalId') = ?`,
    )
    .run(externalId);

  // 2. Purge non-event sidecar substrate (not rebuilt by replay).
  if (tableExists(store, DEFAULT_VEC_TABLE)) {
    sqlite.query(`DELETE FROM ${DEFAULT_VEC_TABLE} WHERE external_id = ?`).run(externalId);
  }
  sqlite.query(`DELETE FROM ${VEC_META_TABLE} WHERE external_id = ?`).run(externalId);
  sqlite.query("DELETE FROM extraction_meta WHERE external_id = ?").run(externalId);

  // 3. Append SourceForgotten — its reducer DELETEs sources / sources_fts
  //    (append + fold in one transaction; replay-stable).
  store.record(
    { type: "SourceForgotten", externalId, ...(reason !== undefined ? { reason } : {}) },
    now,
  );

  return { externalId, status: "forgotten" };
}
