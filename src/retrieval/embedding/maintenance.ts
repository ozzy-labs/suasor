/**
 * Embedding maintenance: status / rebuild / drain / find-duplicates (ADR-0006).
 *
 * The `[embedding].backend` sidecar populates vec0 during sync, but that layer
 * is otherwise invisible to operators. These verbs make it observable and
 * repairable without leaving the local store:
 *
 * - `status`     — how many sources are embedded vs pending, per entity kind,
 *                  plus the active backend/model and any model drift.
 * - `rebuild`    — re-embed sources whose recorded model differs from the active
 *                  one (or, with `full`, every source) so a model swap takes hold.
 * - `drain`      — catch-up re-embed of sources that have no vector yet (the
 *                  best-effort ingest path skipped them when the sidecar failed).
 * - `findDuplicates` — list near-duplicate source pairs over vec0 (cosine).
 *
 * All ML stays delegated to the {@link Embedder} sidecar (ADR-0006): this module
 * only orchestrates SQL over the local vec0 table + `embeddings_meta` sidecar and
 * the thin embedder client. Every verb is a no-op when no embedder is configured
 * (backend disabled) — the caller surfaces an explicit message.
 */
import type { Database } from "bun:sqlite";
import { DEFAULT_VEC_TABLE, VEC_META_TABLE } from "../../db/connection.ts";
import { type Embedder, EmbeddingError } from "./embedder.ts";
import { upsertSourceVector, type VectorProvenance } from "./recall.ts";

/** Per-entity-kind embedding coverage (one row per `sources.source_type`). */
export interface EmbeddingKindStatus {
  /** Entity kind (`sources.source_type`, e.g. `github_issue`). */
  sourceType: string;
  /** Sources of this kind present in the projection. */
  total: number;
  /** Sources of this kind with a current-model vector in vec0. */
  embedded: number;
  /** Sources of this kind missing a vector (best-effort ingest catch-up). */
  pending: number;
  /** Sources of this kind whose vector was produced by a different model. */
  stale: number;
}

/** Snapshot returned by {@link embeddingStatus}. */
export interface EmbeddingStatus {
  /** Active embedding backend (`disabled` when no embedder is configured). */
  backend: string;
  /** Active model id (`null` when the backend is disabled). */
  modelId: string | null;
  /** Active model version tag (empty string when the sidecar exposes none). */
  modelVersion: string;
  /** Whether the sidecar auto-embeds on sync (true once a backend is enabled). */
  auto: boolean;
  /** Per-entity-kind coverage, sorted by `sourceType`. */
  kinds: EmbeddingKindStatus[];
  /** Roll-up across kinds. */
  totals: { total: number; embedded: number; pending: number; stale: number };
}

interface KindRow {
  source_type: string;
  total: number;
  embedded: number;
  stale: number;
}

/**
 * Coverage snapshot of the embedding layer.
 *
 * `embedder === null` (backend disabled) yields a snapshot with `backend:
 * "disabled"`, `auto: false`, and zeroed embedded/stale counts — sources still
 * count toward `total` so an operator sees what *would* be embedded once a
 * backend is enabled. With an embedder, a source is `embedded` when its
 * `embeddings_meta` row matches the active (model_id, model_version), `stale`
 * when it has a vector under a different model, and `pending` otherwise.
 */
export function embeddingStatus(
  sqlite: Database,
  embedder: Embedder | null,
  backend = "disabled",
): EmbeddingStatus {
  const modelId = embedder?.model ?? null;
  const modelVersion = embedder?.modelVersion ?? "";

  // Left-join sources → meta so kinds with zero coverage still appear. A meta
  // row counts as `embedded` only when it matches the active (model_id,
  // model_version); a present-but-different vector is `stale`. When the backend
  // is disabled (modelId null) there is no active model, so we pin ?1 to a value
  // no real row carries — embedded/stale resolve to 0 and every source falls
  // into `pending` below.
  const activeId = modelId ?? " __none__";
  const rows = sqlite
    .query<KindRow, [string, string]>(
      `SELECT s.source_type AS source_type,
              COUNT(*)       AS total,
              COALESCE(SUM(
                CASE WHEN m.model_id = ?1 AND m.model_version = ?2 THEN 1 ELSE 0 END
              ), 0) AS embedded,
              COALESCE(SUM(
                CASE WHEN m.external_id IS NOT NULL
                       AND NOT (m.model_id = ?1 AND m.model_version = ?2) THEN 1 ELSE 0 END
              ), 0) AS stale
         FROM sources s
         LEFT JOIN ${VEC_META_TABLE} m ON m.external_id = s.external_id
        GROUP BY s.source_type
        ORDER BY s.source_type ASC`,
    )
    .all(activeId, modelVersion);

  const kinds: EmbeddingKindStatus[] = rows.map((r) => {
    const embedded = modelId === null ? 0 : r.embedded;
    const stale = modelId === null ? 0 : r.stale;
    const pending = r.total - embedded - stale;
    return { sourceType: r.source_type, total: r.total, embedded, pending, stale };
  });

  const totals = kinds.reduce(
    (acc, k) => ({
      total: acc.total + k.total,
      embedded: acc.embedded + k.embedded,
      pending: acc.pending + k.pending,
      stale: acc.stale + k.stale,
    }),
    { total: 0, embedded: 0, pending: 0, stale: 0 },
  );

  return {
    backend,
    modelId,
    modelVersion,
    auto: embedder !== null,
    kinds,
    totals,
  };
}

/** A source missing a current-model vector (drilldown for `embeddings status`). */
export interface FailedEmbedding {
  /** Source external id. */
  externalId: string;
  /** Source kind (`sources.source_type`). */
  sourceType: string;
  /**
   * Why the source has no usable vector:
   * - `pending` — no `embeddings_meta` row at all (ingest skipped it / sidecar was down).
   * - `stale`   — embedded under a different model (run `embeddings rebuild`).
   */
  reason: "pending" | "stale";
}

/**
 * List sources that have no current-model vector — the drilldown behind the
 * `pending` / `stale` roll-ups in {@link embeddingStatus} (Issue #202).
 *
 * `pending` rows have no `embeddings_meta` entry (the best-effort ingest path
 * skipped them when the sidecar was down → fixable with `embeddings drain`);
 * `stale` rows carry a vector from a different (model_id, model_version) →
 * fixable with `embeddings rebuild`. Returns at most `limit` rows (default 50),
 * pending first then stale, each group ordered by `external_id`. When the
 * backend is disabled (`activeModelId === null`) every source counts as
 * `pending` since there is no active model to satisfy. Read-only.
 */
export function listFailedEmbeddings(
  sqlite: Database,
  activeModelId: string | null,
  activeModelVersion: string,
  limit = 50,
): FailedEmbedding[] {
  // Pin ?1 to a value no real row carries when disabled, so every meta row is
  // treated as a non-match (→ stale) and meta-less sources stay pending.
  const activeId = activeModelId ?? " __none__";
  const rows = sqlite
    .query<
      { external_id: string; source_type: string; reason: "pending" | "stale" },
      [string, string, number]
    >(
      `SELECT s.external_id AS external_id,
              s.source_type AS source_type,
              CASE WHEN m.external_id IS NULL THEN 'pending' ELSE 'stale' END AS reason
         FROM sources s
         LEFT JOIN ${VEC_META_TABLE} m ON m.external_id = s.external_id
        WHERE m.external_id IS NULL
           OR NOT (m.model_id = ?1 AND m.model_version = ?2)
        ORDER BY (CASE WHEN m.external_id IS NULL THEN 0 ELSE 1 END) ASC,
                 s.external_id ASC
        LIMIT ?3`,
    )
    .all(activeId, activeModelVersion, limit);
  return rows.map((r) => ({
    externalId: r.external_id,
    sourceType: r.source_type,
    reason: r.reason,
  }));
}

/** Outcome of a {@link embeddingRebuild} / {@link embeddingDrain} run. */
export interface EmbeddingRebuildResult {
  /** Sources considered for (re)embedding this run. */
  candidates: number;
  /** Sources actually embedded (best-effort; sidecar failures lower this). */
  embedded: number;
  /** A sidecar error, if one interrupted the run (best-effort: partial counts). */
  error?: EmbeddingError;
}

interface SourceRow {
  external_id: string;
  body: string;
}

/** Fetch (external_id, body) for the given external ids, preserving order. */
function fetchBodies(sqlite: Database, ids: string[]): SourceRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  return sqlite
    .query<SourceRow, string[]>(
      `SELECT external_id, body FROM sources WHERE external_id IN (${placeholders})`,
    )
    .all(...ids);
}

/**
 * Maintenance-level batch size: how many sources are fetched + embedded per
 * chunk. Bounding this keeps peak memory flat regardless of corpus size (we never
 * hold every body + every vector at once) and drives the progress indicator (a
 * tick per source). The embedder splits further internally if its own `maxBatch`
 * is smaller (ADR-0006 / embedder.ts); this only caps the maintenance loop.
 */
const MAINTENANCE_EMBED_BATCH = 128;

/**
 * Embed the given source ids in bounded chunks and upsert each vector with
 * provenance. Best-effort: on the first sidecar error the run stops and returns
 * the partial `embedded` count gathered from earlier chunks (ADR-0006).
 * `onProgress` (when given) fires once per source processed.
 */
async function embedAndStore(
  sqlite: Database,
  embedder: Embedder,
  ids: string[],
  onProgress?: () => void,
): Promise<EmbeddingRebuildResult> {
  if (ids.length === 0) return { candidates: 0, embedded: 0 };
  const provenance: VectorProvenance = {
    modelId: embedder.model,
    modelVersion: embedder.modelVersion ?? "",
  };
  let embedded = 0;
  for (let start = 0; start < ids.length; start += MAINTENANCE_EMBED_BATCH) {
    const chunk = ids.slice(start, start + MAINTENANCE_EMBED_BATCH);
    const rows = fetchBodies(sqlite, chunk);
    let vectors: number[][];
    try {
      vectors = await embedder.embed(rows.map((r) => r.body));
    } catch (cause) {
      return {
        candidates: ids.length,
        embedded,
        error: cause instanceof EmbeddingError ? cause : new EmbeddingError(String(cause), cause),
      };
    }
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const vector = vectors[i];
      if (row && vector) {
        upsertSourceVector(sqlite, row.external_id, vector, provenance);
        embedded++;
      }
      onProgress?.();
    }
  }
  return { candidates: ids.length, embedded };
}

/**
 * Re-embed sources whose recorded model differs from the active one (model swap).
 *
 * With `full: false` (default) only sources whose `embeddings_meta` is missing or
 * was produced by a different (model_id, model_version) are re-embedded — leaving
 * up-to-date vectors untouched (idempotent on a settled store). With `full: true`
 * every source is re-embedded regardless. Best-effort: a sidecar error stops the
 * run and is returned with the partial `embedded` count (ADR-0006).
 */
export async function embeddingRebuild(
  sqlite: Database,
  embedder: Embedder,
  options: { full?: boolean; onProgress?: () => void } = {},
): Promise<EmbeddingRebuildResult> {
  const modelId = embedder.model;
  const modelVersion = embedder.modelVersion ?? "";
  const ids = options.full
    ? sqlite.query<{ external_id: string }, []>(`SELECT external_id FROM sources`).all()
    : sqlite
        .query<{ external_id: string }, [string, string]>(
          `SELECT s.external_id AS external_id
             FROM sources s
             LEFT JOIN ${VEC_META_TABLE} m ON m.external_id = s.external_id
            WHERE m.external_id IS NULL
               OR NOT (m.model_id = ? AND m.model_version = ?)`,
        )
        .all(modelId, modelVersion);
  return embedAndStore(
    sqlite,
    embedder,
    ids.map((r) => r.external_id),
    options.onProgress,
  );
}

/**
 * Catch-up re-embed of sources that have *no* vector yet (pending drain).
 *
 * Unlike {@link embeddingRebuild} this only targets sources missing an
 * `embeddings_meta` row entirely — the ones the best-effort ingest path skipped
 * when the sidecar was down. Stale-but-present vectors are left for `rebuild`.
 */
export async function embeddingDrain(
  sqlite: Database,
  embedder: Embedder,
  options: { onProgress?: () => void } = {},
): Promise<EmbeddingRebuildResult> {
  const ids = sqlite
    .query<{ external_id: string }, []>(
      `SELECT s.external_id AS external_id
         FROM sources s
         LEFT JOIN ${VEC_META_TABLE} m ON m.external_id = s.external_id
        WHERE m.external_id IS NULL`,
    )
    .all();
  return embedAndStore(
    sqlite,
    embedder,
    ids.map((r) => r.external_id),
    options.onProgress,
  );
}

/** A near-duplicate source pair found by {@link findDuplicates}. */
export interface DuplicatePair {
  /** First source external id (lexicographically smaller of the pair). */
  a: string;
  /** Second source external id. */
  b: string;
  /** Cosine similarity in [0, 1] (1 = identical direction). */
  similarity: number;
}

/** Default cosine-similarity threshold above which a pair is a near-duplicate. */
export const DEFAULT_DUPLICATE_THRESHOLD = 0.95;

interface VecBlobRow {
  external_id: string;
  embedding: Uint8Array;
}

/** Cosine similarity of two equal-length vectors (0 when either is zero-norm). */
function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * List near-duplicate source pairs whose cosine similarity exceeds `threshold`.
 *
 * Reads stored vectors from vec0 and compares every pair (small local corpora;
 * the maintenance verb is interactive, not a hot path). Pairs are returned with
 * `a < b` lexicographically and sorted by descending similarity. The active
 * `embedder` is unused for the comparison (vectors are already stored) but its
 * presence gates the verb — a disabled backend means there is nothing to compare.
 *
 * The pairwise comparison is O(n²); on a large corpus it can run for many seconds
 * with no output. `onProgress` (when given) fires once per outer-loop iteration
 * (i.e. per vector scanned against the rest) so the CLI can surface progress.
 */
export function findDuplicates(
  sqlite: Database,
  threshold: number = DEFAULT_DUPLICATE_THRESHOLD,
  onProgress?: () => void,
): DuplicatePair[] {
  // Only compare vectors whose source still exists (JOIN drops orphan vectors,
  // mirroring recallSearch). Order by external_id for deterministic pairing.
  const rows = sqlite
    .query<VecBlobRow, []>(
      `SELECT v.external_id AS external_id, v.embedding AS embedding
         FROM ${DEFAULT_VEC_TABLE} v
         JOIN sources s ON s.external_id = v.external_id
        ORDER BY v.external_id ASC`,
    )
    .all();

  const vectors = rows.map((r) => ({
    id: r.external_id,
    vec: new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4),
  }));

  const pairs: DuplicatePair[] = [];
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      const left = vectors[i];
      const right = vectors[j];
      if (!left || !right) continue;
      const similarity = cosine(left.vec, right.vec);
      if (similarity >= threshold) {
        pairs.push({ a: left.id, b: right.id, similarity });
      }
    }
    onProgress?.();
  }
  pairs.sort((p, q) => q.similarity - p.similarity);
  return pairs;
}
