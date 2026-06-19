/**
 * Recall: semantic (embedding) search + vec0 maintenance (ADR-0005, FR-RET-2).
 *
 * Recall is the optional enhancement layer over FTS-first `search`: it embeds
 * the query with the *same* model used at ingest and finds the nearest source
 * vectors in the `embeddings_vec_default` vec0 table. When no embedder is
 * configured it degrades gracefully — empty hits + the `embedding_disabled`
 * signal — so the host falls back to FTS (`search`). Per ADR-0006 all ML is
 * delegated to a sidecar/API behind the {@link Embedder} client.
 *
 * Vectors are stored as little-endian float32 blobs (sqlite-vec's `float[N]`
 * column format). Upserts are delete-then-insert keyed by `external_id`, mirror-
 * ing how the FTS reducer keeps `sources_fts` in sync, so a rebuild or a body
 * update repopulates cleanly.
 */
import type { Database } from "bun:sqlite";
import { DEFAULT_VEC_TABLE, VEC_META_TABLE } from "../../db/connection.ts";
import type { SearchHit } from "../search.ts";
import { type Embedder, EmbeddingError } from "./embedder.ts";

/** Default number of nearest neighbours to retrieve. */
export const DEFAULT_RECALL_LIMIT = 20;

/** Signal returned when recall has no embedding backend (graceful degrade). */
export const EMBEDDING_DISABLED_SIGNAL = "embedding_disabled";

/** Why recall returned no semantic hits (diagnostic; `signal` is canonical). */
export type RecallReason = "backend_disabled" | "ok";

/** A recall result: either ranked semantic hits, or a graceful-degrade signal. */
export interface RecallResult {
  /** Nearest-neighbour hits, best-first (smallest distance). Empty on degrade. */
  hits: SearchHit[];
  /** `embedding_disabled` when no embedder is available, else absent. */
  signal?: typeof EMBEDDING_DISABLED_SIGNAL;
  /** Diagnostic reason (host keys off `signal`, not this). */
  reason: RecallReason;
}

export interface RecallOptions {
  /** Max neighbours to return (default {@link DEFAULT_RECALL_LIMIT}). */
  limit?: number;
}

/** Encode an embedding vector as a little-endian float32 blob for sqlite-vec. */
export function toVectorBlob(vector: number[]): Uint8Array {
  return new Uint8Array(Float32Array.from(vector).buffer);
}

/** Model provenance recorded alongside a stored vector (maintenance verbs). */
export interface VectorProvenance {
  /** Model identifier (`embedder.model`); pins the vector space. */
  modelId: string;
  /** Optional model build/version tag (`embedder.modelVersion`, default ""). */
  modelVersion?: string;
  /** ISO timestamp the vector was embedded (default `now`). */
  embeddedAt?: string;
}

/**
 * Upsert a single source's embedding into the vec0 table (delete-then-insert,
 * keyed by `external_id`). Idempotent: re-embedding the same source replaces the
 * prior vector rather than duplicating it.
 *
 * When `provenance` is supplied the model identity is mirrored into the
 * `embeddings_meta` sidecar so the maintenance verbs (status / rebuild / drain,
 * ADR-0006) can tell embedded sources apart and detect model drift. Callers that
 * omit it (legacy tests) leave the sidecar untouched.
 */
export function upsertSourceVector(
  sqlite: Database,
  externalId: string,
  vector: number[],
  provenance?: VectorProvenance,
): void {
  const blob = toVectorBlob(vector);
  sqlite.query(`DELETE FROM ${DEFAULT_VEC_TABLE} WHERE external_id = ?`).run(externalId);
  sqlite
    .query(`INSERT INTO ${DEFAULT_VEC_TABLE} (external_id, embedding) VALUES (?, ?)`)
    .run(externalId, blob);
  if (provenance) {
    sqlite.query(`DELETE FROM ${VEC_META_TABLE} WHERE external_id = ?`).run(externalId);
    sqlite
      .query(
        `INSERT INTO ${VEC_META_TABLE} (external_id, model_id, model_version, embedded_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        externalId,
        provenance.modelId,
        provenance.modelVersion ?? "",
        provenance.embeddedAt ?? new Date().toISOString(),
      );
  }
}

/**
 * Embed and store vectors for the given sources (ingest-time population).
 *
 * Document and query embeddings share `embedder.model`, keeping one vector
 * space (mixing models silently degrades recall). Embedding is best-effort over
 * the optional sidecar: on an {@link EmbeddingError} the vectors are simply not
 * written (FTS still works), and the error is returned so the caller can log it
 * without failing the ingest. Returns the count actually embedded.
 */
export async function embedSources(
  sqlite: Database,
  embedder: Embedder,
  sources: { externalId: string; body: string }[],
): Promise<{ embedded: number; error?: EmbeddingError }> {
  if (sources.length === 0) return { embedded: 0 };
  let vectors: number[][];
  try {
    vectors = await embedder.embed(sources.map((s) => s.body));
  } catch (cause) {
    return {
      embedded: 0,
      error: cause instanceof EmbeddingError ? cause : new EmbeddingError(String(cause), cause),
    };
  }
  const provenance: VectorProvenance = {
    modelId: embedder.model,
    modelVersion: embedder.modelVersion ?? "",
  };
  let embedded = 0;
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    const vector = vectors[i];
    if (source && vector) {
      upsertSourceVector(sqlite, source.externalId, vector, provenance);
      embedded++;
    }
  }
  return { embedded };
}

interface VecRow {
  external_id: string;
  source_type: string;
  observed_at: string;
  body: string;
  distance: number;
}

/**
 * Semantic search over ingested sources (FR-RET-2).
 *
 * Embeds `query` with the same model used at ingest, runs a vec0 KNN search, and
 * joins back to the `sources` projection for metadata/body. The `score` is the
 * vec0 L2 distance (smaller = closer; hits are returned best-first).
 *
 * Graceful degradation (ADR-0005): when `embedder` is `null` (no backend, or a
 * backend not yet implemented) this returns empty hits with the
 * `embedding_disabled` signal instead of erroring, so the host falls back to FTS
 * `search`. An empty/whitespace query likewise yields no hits. A sidecar failure
 * propagates as an {@link EmbeddingError} so the caller can decide to degrade.
 */
export async function recallSearch(
  sqlite: Database,
  embedder: Embedder | null,
  query: string,
  options: RecallOptions = {},
): Promise<RecallResult> {
  if (embedder === null) {
    return { hits: [], signal: EMBEDDING_DISABLED_SIGNAL, reason: "backend_disabled" };
  }

  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return { hits: [], reason: "ok" };
  }

  const limit = options.limit ?? DEFAULT_RECALL_LIMIT;
  const [vector] = await embedder.embed([trimmed]);
  if (!vector) {
    throw new EmbeddingError("embedder returned no vector for the query");
  }

  const rows = sqlite
    .query<VecRow, [Uint8Array, number]>(
      `SELECT v.external_id   AS external_id,
              s.source_type   AS source_type,
              s.observed_at   AS observed_at,
              s.body          AS body,
              v.distance      AS distance
         FROM ${DEFAULT_VEC_TABLE} v
         JOIN sources s ON s.external_id = v.external_id
        WHERE v.embedding MATCH ? AND k = ?
        ORDER BY v.distance ASC`,
    )
    .all(toVectorBlob(vector), limit);

  const hits: SearchHit[] = rows.map((r) => ({
    externalId: r.external_id,
    sourceType: r.source_type,
    observedAt: r.observed_at,
    score: r.distance,
    body: r.body,
  }));
  return { hits, reason: "ok" };
}
