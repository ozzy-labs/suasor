/**
 * Embedder abstraction + sidecar clients (ADR-0005 / ADR-0006, FR-RET-2).
 *
 * Embedding is an *optional enhancement* over FTS-first retrieval: it crosses
 * the wall FTS cannot (JA↔EN language jump, vocabulary mismatch). Per the ML
 * delegation invariant (ADR-0006) Suasor never runs heavy ML in-process — an
 * `Embedder` is a **thin client** over a local sidecar (Ollama `/api/embed`) or
 * an external API. No torch, no model files in `src/`.
 *
 * Both ingest (document embedding) and recall (query embedding) go through the
 * same `Embedder` instance, so they share one `model` and therefore one vector
 * space (mixing models silently destroys recall — see EmbeddingConfig.model).
 */
import type { EmbeddingConfig } from "../../config/schema.ts";

/** A thin embedding client. Delegates to a sidecar/API — never in-process ML. */
export interface Embedder {
  /** Model identifier (pins the vector space; ingest and query must match). */
  readonly model: string;
  /**
   * Embed one or more texts, returning a vector per input (same order). An
   * empty input array returns an empty array without any network call.
   */
  embed(texts: string[]): Promise<number[][]>;
}

/** Raised when a sidecar/API call fails or returns a malformed response. */
export class EmbeddingError extends Error {
  constructor(
    message: string,
    /** Underlying cause (network error, non-2xx body, etc.), if any. */
    cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "EmbeddingError";
  }
}

/** Minimal `fetch` shape used by the clients (injectable for tests). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface OllamaEmbedderOptions {
  /** Sidecar base URL (e.g. `http://localhost:11434`). */
  baseUrl: string;
  /** Model name (e.g. `bge-m3`). Pins the vector space. */
  model: string;
  /** Injectable fetch (defaults to global `fetch`). */
  fetchImpl?: FetchLike;
}

/** Shape of a successful Ollama `/api/embed` response (newer batch API). */
interface OllamaEmbedResponse {
  embeddings?: number[][];
}

/**
 * Embedder over the Ollama sidecar `POST /api/embed` endpoint (ADR-0006).
 *
 * Uses the batch `/api/embed` API: `{ model, input: string[] }` →
 * `{ embeddings: number[][] }`. The call is local (no egress) and carries no
 * secrets. A non-2xx response or a malformed body raises `EmbeddingError` so
 * the caller can degrade gracefully (recall returns `embedding_disabled`).
 */
export class OllamaEmbedder implements Embedder {
  readonly model: string;
  private readonly endpoint: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: OllamaEmbedderOptions) {
    this.model = options.model;
    // Trim a single trailing slash so `baseUrl` with or without one both work.
    this.endpoint = `${options.baseUrl.replace(/\/$/, "")}/api/embed`;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, input: texts }),
      });
    } catch (cause) {
      throw new EmbeddingError(`ollama embed request failed: ${this.endpoint}`, cause);
    }

    if (!response.ok) {
      throw new EmbeddingError(`ollama embed returned HTTP ${response.status}`);
    }

    let body: OllamaEmbedResponse;
    try {
      body = (await response.json()) as OllamaEmbedResponse;
    } catch (cause) {
      throw new EmbeddingError("ollama embed returned a non-JSON body", cause);
    }

    const vectors = body.embeddings;
    if (!Array.isArray(vectors) || vectors.length !== texts.length) {
      throw new EmbeddingError(
        `ollama embed returned ${vectors?.length ?? 0} vectors for ${texts.length} inputs`,
      );
    }
    return vectors;
  }
}

/**
 * Build an `Embedder` from the effective `[embedding]` config, or `null` when no
 * embedder is available (backend `disabled`, or a backend that is config-
 * accepted but not yet implemented here — openai/voyage). A `null` embedder is
 * the graceful-degradation signal: recall returns `embedding_disabled` and the
 * host falls back to FTS `search` (ADR-0005).
 */
export function createEmbedder(
  config: Pick<EmbeddingConfig, "backend" | "baseUrl" | "model">,
  fetchImpl?: FetchLike,
): Embedder | null {
  if (config.backend === "ollama") {
    return new OllamaEmbedder({
      baseUrl: config.baseUrl,
      model: config.model,
      ...(fetchImpl ? { fetchImpl } : {}),
    });
  }
  // disabled (default) and not-yet-implemented backends (openai/voyage) degrade
  // gracefully: no embedder → recall returns the embedding_disabled signal.
  return null;
}
