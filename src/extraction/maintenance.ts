/**
 * Document-extraction maintenance — coverage status (ADR-0024 §6).
 *
 * Reads the `extraction_meta` derived substrate (which extractor version produced
 * each source's body) and the `sources` projection to report coverage: how many
 * sources are extracted, how many are stale (recorded version ≠ current → will
 * re-extract on the next sync), and how many are pending (extractable but never
 * attempted). Side-effect free (SELECTs only); backs `suasor extraction status`.
 */
import type { Database } from "bun:sqlite";
import { extname } from "node:path";
import { EXTRACTABLE_EXTENSIONS } from "./extractor.ts";

/**
 * `source_type`s that can carry an `extractable` handle (ADR-0024). `pending` /
 * `stale` backfill is tracked for these. `local_file` is the initial scope;
 * `box_file` joins as the Box API connector grows content fetch (PR-2 / #241).
 * Drive / OneDrive extend this set in their follow-ups (#242 / #243).
 */
export const EXTRACTABLE_SOURCE_TYPES = ["local_file", "box_file"] as const;

/** SQL `IN (...)` placeholder list + bound params for {@link EXTRACTABLE_SOURCE_TYPES}. */
const SOURCE_TYPE_IN = EXTRACTABLE_SOURCE_TYPES.map(() => "?").join(", ");

/** Coverage snapshot for the extraction layer. */
export interface ExtractionStatus {
  /** Configured backend (`disabled` keeps Office/PDF name-only). */
  backend: string;
  /** Current extractor version (`extraction_meta` rows with another are stale). */
  version: string;
  totals: {
    /** Sources whose body is sidecar-extracted at the current version. */
    extracted: number;
    /** Recorded as unsupported by the sidecar (won't retry until version bump). */
    unsupported: number;
    /** Skipped as oversized (ADR-0024 §5). */
    tooLarge: number;
    /** Extracted at a different version → re-extract on next sync (drift). */
    stale: number;
    /** Extractable sources never attempted (e.g. extraction newly enabled). */
    pending: number;
  };
}

interface MetaRow {
  state: string;
  version: string;
}

/**
 * Compute extraction coverage from `extraction_meta` + `sources`. `pending`
 * counts sources of an {@link EXTRACTABLE_SOURCE_TYPES} type whose filename
 * extension is extractable but which have no `extraction_meta` row yet (the
 * backfill the next sync will pick up).
 */
export function extractionStatus(
  sqlite: Database,
  config: { backend: string; version: string },
): ExtractionStatus {
  const metaRows = sqlite.query<MetaRow, []>("SELECT state, version FROM extraction_meta").all();

  let extracted = 0;
  let unsupported = 0;
  let tooLarge = 0;
  let stale = 0;
  for (const row of metaRows) {
    if (row.version !== config.version) stale += 1;
    else if (row.state === "extracted") extracted += 1;
    else if (row.state === "unsupported") unsupported += 1;
    else if (row.state === "too_large") tooLarge += 1;
  }

  const attempted = new Set(
    sqlite
      .query<{ external_id: string }, []>("SELECT external_id FROM extraction_meta")
      .all()
      .map((r) => r.external_id),
  );
  const candidates = sqlite
    .query<{ external_id: string; name: string | null }, string[]>(
      `SELECT external_id, json_extract(meta, '$.name') AS name FROM sources WHERE source_type IN (${SOURCE_TYPE_IN})`,
    )
    .all(...EXTRACTABLE_SOURCE_TYPES);
  let pending = 0;
  for (const row of candidates) {
    if (row.name === null) continue;
    if (
      EXTRACTABLE_EXTENSIONS.has(extname(row.name).toLowerCase()) &&
      !attempted.has(row.external_id)
    ) {
      pending += 1;
    }
  }

  return {
    backend: config.backend,
    version: config.version,
    totals: { extracted, unsupported, tooLarge, stale, pending },
  };
}

/** A source awaiting extraction (drilldown for `extraction status`). */
export interface PendingExtraction {
  /** Source external id. */
  externalId: string;
  /** File name (`sources.meta.$.name`), used to classify extractability. */
  name: string;
  /**
   * Why the source is awaiting (re)extraction:
   * - `pending` — extractable but never attempted (no `extraction_meta` row).
   * - `stale`   — extracted under a different version (re-extracted next sync).
   */
  reason: "pending" | "stale";
}

/**
 * List sources awaiting (re)extraction — the drilldown behind the `pending` /
 * `stale` roll-ups in {@link extractionStatus} (Issue #202).
 *
 * `pending` rows are {@link EXTRACTABLE_SOURCE_TYPES} sources whose extension is
 * extractable but which have no `extraction_meta` row (backfill the next sync
 * picks up);
 * `stale` rows were extracted under a different `version` (drift → re-extracted
 * next sync). Returns at most `limit` rows (default 50), pending first then
 * stale, each group ordered by `external_id`. Read-only (SELECTs only).
 */
export function listPendingExtractions(
  sqlite: Database,
  config: { version: string },
  limit = 50,
): PendingExtraction[] {
  const attempted = new Map(
    sqlite
      .query<{ external_id: string; version: string }, []>(
        "SELECT external_id, version FROM extraction_meta",
      )
      .all()
      .map((r) => [r.external_id, r.version] as const),
  );
  const candidates = sqlite
    .query<{ external_id: string; name: string | null }, string[]>(
      `SELECT external_id, json_extract(meta, '$.name') AS name FROM sources WHERE source_type IN (${SOURCE_TYPE_IN}) ORDER BY external_id ASC`,
    )
    .all(...EXTRACTABLE_SOURCE_TYPES);

  const pending: PendingExtraction[] = [];
  const stale: PendingExtraction[] = [];
  for (const row of candidates) {
    if (row.name === null) continue;
    if (!EXTRACTABLE_EXTENSIONS.has(extname(row.name).toLowerCase())) continue;
    const recorded = attempted.get(row.external_id);
    if (recorded === undefined) {
      pending.push({ externalId: row.external_id, name: row.name, reason: "pending" });
    } else if (recorded !== config.version) {
      stale.push({ externalId: row.external_id, name: row.name, reason: "stale" });
    }
  }
  return [...pending, ...stale].slice(0, limit);
}
