/**
 * Embedder abstraction + sidecar/API clients (ADR-0005 / ADR-0006, FR-RET-2).
 *
 * Embedding is an *optional enhancement* over FTS-first retrieval: it crosses
 * the wall FTS cannot (JA↔EN language jump, vocabulary mismatch). Per the ML
 * delegation invariant (ADR-0006) Suasor never runs heavy ML in-process — an
 * `Embedder` is a **thin client** over a local sidecar (Ollama `/api/embed`) or
 * an external API (OpenAI / Voyage). No torch, no model files in `src/`.
 *
 * Both ingest (document embedding) and recall (query embedding) go through the
 * same `Embedder` instance, so they share one `model` and therefore one vector
 * space (mixing models silently destroys recall — see EmbeddingConfig.model).
 *
 * The external backends (OpenAI / Voyage) send document/query text to a remote
 * API — an **egress** that crosses the local-first / content-minimization
 * boundary (ADR-0003). They are off by default, opt-in only, and their API keys
 * are resolved from the OS keychain / env (never written to config). See
 * {@link resolveEmbeddingApiKey} and docs/guide/embedding.md.
 */
import type { EmbeddingBackend, EmbeddingConfig } from "../../config/schema.ts";
import { resolveEmbeddingApiKey, type SecretStoreOptions } from "../../connectors/secrets.ts";
import { fetchWithRetry, type SleepLike } from "../../util/retry.ts";

/** A thin embedding client. Delegates to a sidecar/API — never in-process ML. */
export interface Embedder {
  /** Model identifier (pins the vector space; ingest and query must match). */
  readonly model: string;
  /**
   * Optional model build/version tag, distinct from {@link model}. Recorded in
   * the provenance sidecar so a model upgrade (same id, newer build) can be
   * detected as stale by `embeddings rebuild` even when `model` is unchanged.
   * Sidecars that do not expose a version leave this undefined (treated as "").
   */
  readonly modelVersion?: string;
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

/**
 * Shared robustness knobs for every embedder (Issue #267). Defaults keep prior
 * behaviour close while adding safety: batch splitting, per-request timeout, and
 * 429/5xx retry with backoff (src/util/retry.ts). The vector space and request
 * *content* are unchanged — only request shape and failure handling (ADR-0003).
 */
export interface EmbedderRobustnessOptions {
  /** Max texts per request; larger inputs are split into ordered chunks. */
  maxBatch?: number;
  /** Per-request timeout in ms (`0` disables). On timeout the attempt retries. */
  requestTimeoutMs?: number;
  /** Max attempts incl. the first for a transient 429/5xx (`1` disables retry). */
  maxRetries?: number;
  /** Sleep override (tests inject a no-op to avoid real backoff waits). */
  sleep?: SleepLike;
  /** Randomness override for backoff jitter (tests inject a fixed value). */
  random?: () => number;
}

/** Default batch size when an embedder is constructed without one. */
const DEFAULT_MAX_BATCH = 64;

/**
 * Split `texts` into chunks of at most `maxBatch`, await `embedChunk` per chunk
 * (sequentially, to keep request rate sane), and concatenate the per-chunk
 * vectors back in input order. An empty input or a non-positive `maxBatch`
 * (defensive) collapses to a single chunk.
 */
async function embedInBatches(
  texts: string[],
  maxBatch: number,
  embedChunk: (chunk: string[]) => Promise<number[][]>,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const size = maxBatch > 0 ? maxBatch : texts.length;
  if (texts.length <= size) return embedChunk(texts);
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += size) {
    const vectors = await embedChunk(texts.slice(i, i + size));
    for (const v of vectors) out.push(v);
  }
  return out;
}

export interface OllamaEmbedderOptions extends EmbedderRobustnessOptions {
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
  private readonly robustness: EmbedderRobustnessOptions;

  constructor(options: OllamaEmbedderOptions) {
    this.model = options.model;
    // Trim a single trailing slash so `baseUrl` with or without one both work.
    this.endpoint = `${options.baseUrl.replace(/\/$/, "")}/api/embed`;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.robustness = options;
  }

  async embed(texts: string[]): Promise<number[][]> {
    // Split into ordered chunks so a large local batch cannot overflow the
    // sidecar in one shot; the sidecar is local (no egress) but still bounded.
    return embedInBatches(texts, this.robustness.maxBatch ?? DEFAULT_MAX_BATCH, (chunk) =>
      this.embedChunk(chunk),
    );
  }

  private async embedChunk(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    // Retry 5xx (and a hung request via timeout) with backoff. Ollama is local,
    // but a restarting/overloaded sidecar returns 5xx that one retry often rides
    // out. A non-2xx that is not 5xx (e.g. 404 bad model) is returned as-is →
    // EmbeddingError below, so a config error fails fast rather than looping.
    let response: Response;
    try {
      response = await fetchEmbedding(this.endpoint, this.robustness, this.fetchImpl, {
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
 * Shared `fetch` wrapper for every embedder: applies the configured retry
 * (429/5xx + transient throws, src/util/retry.ts) and per-request timeout. Kept
 * as a free function so Ollama and the OpenAI-compatible base share one policy.
 */
function fetchEmbedding(
  endpoint: string,
  robustness: EmbedderRobustnessOptions,
  fetchImpl: FetchLike,
  init: RequestInit,
): Promise<Response> {
  return fetchWithRetry(endpoint, init, {
    fetchImpl,
    maxAttempts: robustness.maxRetries ?? 3,
    timeoutMs: robustness.requestTimeoutMs ?? 60_000,
    ...(robustness.sleep ? { sleep: robustness.sleep } : {}),
    ...(robustness.random ? { random: robustness.random } : {}),
  });
}

/** Default OpenAI embeddings base URL (`/v1/embeddings` appended by the client). */
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com";
/** Default Voyage embeddings base URL (`/v1/embeddings` appended by the client). */
export const DEFAULT_VOYAGE_BASE_URL = "https://api.voyageai.com";

export interface OpenAICompatibleEmbedderOptions extends EmbedderRobustnessOptions {
  /** API base URL (e.g. `https://api.openai.com`). `/v1/embeddings` is appended. */
  baseUrl: string;
  /** Model name (e.g. `text-embedding-3-small`). Pins the vector space. */
  model: string;
  /** Bearer API key (resolved from keychain/env — never from config). */
  apiKey: string;
  /** Injectable fetch (defaults to global `fetch`). */
  fetchImpl?: FetchLike;
}

/**
 * Shape of a successful OpenAI-compatible `/v1/embeddings` response. Both OpenAI
 * and Voyage return `{ data: [{ index, embedding }, ...] }`; `index` reflects the
 * position of each vector in the input array (used to restore input order).
 */
interface OpenAIEmbeddingsResponse {
  data?: { index?: number; embedding?: number[] }[];
}

/**
 * Embedder over an OpenAI-compatible `POST {baseUrl}/v1/embeddings` API. Used by
 * both {@link OpenAIEmbedder} and {@link VoyageEmbedder}, which share the request
 * (`{ model, input: string[] }` + `Authorization: Bearer <key>`) and response
 * (`{ data: [{ index, embedding }] }`) shape.
 *
 * Unlike the Ollama sidecar this call is an **egress** (body text leaves the
 * machine, ADR-0003) and carries the API key, so the embedder is only built when
 * a key is resolved (see {@link createEmbedderResolved}). A non-2xx response, a
 * malformed body, or a vector-count mismatch raises `EmbeddingError` so recall
 * degrades gracefully (`embedding_disabled` → FTS).
 *
 * Vectors are reordered by the response `index` field before return so callers
 * always get one vector per input in input order, regardless of API ordering.
 */
abstract class OpenAICompatibleEmbedder implements Embedder {
  readonly model: string;
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly robustness: EmbedderRobustnessOptions;
  /** Provider label for error messages (e.g. `openai`, `voyage`). */
  protected abstract readonly provider: string;

  constructor(options: OpenAICompatibleEmbedderOptions) {
    this.model = options.model;
    this.robustness = options;
    const base = options.baseUrl.replace(/\/$/, "");
    // Require TLS for external backends: the Bearer API key egresses with every
    // request (ADR-0003), so a non-https baseUrl would send the secret in
    // cleartext. Fail closed on a misconfigured scheme rather than leak the key.
    // `localhost` over http is allowed for tests/local proxies (no real egress).
    if (!/^https:\/\//i.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(base)) {
      throw new EmbeddingError(
        "external embedding baseUrl must use https:// (the API key is sent on every request)",
      );
    }
    this.endpoint = `${base}/v1/embeddings`;
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async embed(texts: string[]): Promise<number[][]> {
    // Split into ordered chunks so a large sync cannot 413 / overflow the model
    // context in one request and lose every vector; results are concatenated in
    // input order. Content is unchanged (ADR-0003) — only request shape.
    return embedInBatches(texts, this.robustness.maxBatch ?? DEFAULT_MAX_BATCH, (chunk) =>
      this.embedChunk(chunk),
    );
  }

  private async embedChunk(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    let response: Response;
    try {
      response = await fetchEmbedding(this.endpoint, this.robustness, this.fetchImpl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, input: texts }),
      });
    } catch (cause) {
      throw new EmbeddingError(`${this.provider} embed request failed: ${this.endpoint}`, cause);
    }

    if (!response.ok) {
      throw new EmbeddingError(`${this.provider} embed returned HTTP ${response.status}`);
    }

    let body: OpenAIEmbeddingsResponse;
    try {
      body = (await response.json()) as OpenAIEmbeddingsResponse;
    } catch (cause) {
      throw new EmbeddingError(`${this.provider} embed returned a non-JSON body`, cause);
    }

    const data = body.data;
    if (!Array.isArray(data) || data.length !== texts.length) {
      throw new EmbeddingError(
        `${this.provider} embed returned ${data?.length ?? 0} vectors for ${texts.length} inputs`,
      );
    }

    // Restore input order via the per-item `index`. Default to array position
    // when `index` is absent (some compatible APIs omit it but keep order). The
    // `vectors[at] !== undefined` guard rejects a duplicate index, which would
    // otherwise leave a hole despite the matching count check above.
    const vectors: number[][] = new Array(texts.length);
    for (let i = 0; i < data.length; i++) {
      const item = data[i];
      const at = typeof item?.index === "number" ? item.index : i;
      const embedding = item?.embedding;
      if (at < 0 || at >= texts.length || !Array.isArray(embedding) || vectors[at] !== undefined) {
        throw new EmbeddingError(`${this.provider} embed returned a malformed data entry`);
      }
      vectors[at] = embedding;
    }
    return vectors;
  }
}

/**
 * Embedder over the OpenAI `POST {baseUrl}/v1/embeddings` API (ADR-0006 thin
 * client). Default model `text-embedding-3-small` (1536-dim). Sends body text to
 * OpenAI — an egress (ADR-0003); off by default, opt-in only.
 */
export class OpenAIEmbedder extends OpenAICompatibleEmbedder {
  protected readonly provider = "openai";
}

/**
 * Embedder over the Voyage AI `POST {baseUrl}/v1/embeddings` API (ADR-0006 thin
 * client). Default model `voyage-3` (1024-dim). Sends body text to Voyage — an
 * egress (ADR-0003); off by default, opt-in only.
 */
export class VoyageEmbedder extends OpenAICompatibleEmbedder {
  protected readonly provider = "voyage";
}

/**
 * Decorator that fail-fasts on a dimension mismatch (Issue #267). The configured
 * `[embedding].dim` sizes the vec0 table at DB creation; if the model actually
 * returns a different dimension (e.g. `dim=1024` left at default while
 * `backend=openai` model `text-embedding-3-small` returns 1536), every vector
 * insert fails and recall silently degrades to empty with no signal.
 *
 * This wraps any {@link Embedder} and, on the **first** non-empty `embed`, checks
 * the returned vector length against `expectedDim`. A mismatch throws an
 * actionable {@link EmbeddingError} (which model/dim disagree, how to fix) so the
 * failure surfaces loudly instead of as empty recall. Once a matching dimension
 * is observed the check is disabled (no per-call overhead). The probe rides the
 * real request — no extra egress.
 */
export class DimensionCheckedEmbedder implements Embedder {
  readonly model: string;
  readonly modelVersion?: string;
  private readonly inner: Embedder;
  private readonly expectedDim: number;
  private verified = false;

  constructor(inner: Embedder, expectedDim: number) {
    this.inner = inner;
    this.expectedDim = expectedDim;
    this.model = inner.model;
    if (inner.modelVersion !== undefined) this.modelVersion = inner.modelVersion;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const vectors = await this.inner.embed(texts);
    if (!this.verified && vectors.length > 0) {
      const actual = vectors[0]?.length ?? 0;
      if (actual !== this.expectedDim) {
        throw new EmbeddingError(
          `embedding dimension mismatch: model "${this.model}" returned ${actual}-dim vectors ` +
            `but [embedding].dim is ${this.expectedDim}. Set [embedding].dim = ${actual} to match ` +
            "the model (a fresh DB or delete + rebuild + re-sync is needed since dim sizes vec0). " +
            "See docs/guide/embedding.md.",
        );
      }
      this.verified = true;
    }
    return vectors;
  }
}

/** Default OpenAI embedding model (`text-embedding-3-small`, 1536-dim). */
export const DEFAULT_OPENAI_MODEL = "text-embedding-3-small";
/** Default Voyage embedding model (`voyage-3`, 1024-dim). */
export const DEFAULT_VOYAGE_MODEL = "voyage-3";

/** External embedding backends whose `embed()` is an egress and needs an API key. */
export const EXTERNAL_EMBEDDING_BACKENDS = new Set<EmbeddingBackend>(["openai", "voyage"]);

/**
 * Build an `Embedder` from the effective `[embedding]` config, or `null` when no
 * embedder is available. `null` is the graceful-degradation signal: recall
 * returns `embedding_disabled` and the host falls back to FTS `search`
 * (ADR-0005). A `null` embedder is returned when:
 *
 * - backend is `disabled` (the default), or
 * - backend is `openai` / `voyage` but no API key was resolved (passed in
 *   `config.apiKey`). External backends are an egress (ADR-0003) gated on a key
 *   held in the keychain/env, never config — callers resolve it via
 *   {@link createEmbedderResolved} (or pass `apiKey` directly in tests).
 *
 * This function is synchronous (no keychain I/O); see `createEmbedderResolved`
 * for the async wrapper that resolves the key first.
 */
export function createEmbedder(
  config: Pick<EmbeddingConfig, "backend" | "baseUrl" | "model"> &
    Partial<Pick<EmbeddingConfig, "dim" | "maxBatch" | "requestTimeoutMs" | "maxRetries">> & {
      apiKey?: string | null;
    },
  fetchImpl?: FetchLike,
  robustnessOverrides: Pick<EmbedderRobustnessOptions, "sleep" | "random"> = {},
): Embedder | null {
  // Robustness knobs shared by every backend (Issue #267): batch/timeout/retry,
  // plus injectable sleep/random for tests. Undefined values fall back to the
  // embedder constructor defaults.
  const robustness: EmbedderRobustnessOptions = {
    ...(config.maxBatch !== undefined ? { maxBatch: config.maxBatch } : {}),
    ...(config.requestTimeoutMs !== undefined ? { requestTimeoutMs: config.requestTimeoutMs } : {}),
    ...(config.maxRetries !== undefined ? { maxRetries: config.maxRetries } : {}),
    ...(robustnessOverrides.sleep ? { sleep: robustnessOverrides.sleep } : {}),
    ...(robustnessOverrides.random ? { random: robustnessOverrides.random } : {}),
  };

  // Wrap with the dimension-mismatch guard when a `dim` is configured so a model
  // whose output dimension disagrees with the vec0 table fails fast (loud) on the
  // first embed rather than silently degrading recall to empty.
  const guard = (embedder: Embedder): Embedder =>
    config.dim !== undefined ? new DimensionCheckedEmbedder(embedder, config.dim) : embedder;

  if (config.backend === "ollama") {
    return guard(
      new OllamaEmbedder({
        baseUrl: config.baseUrl,
        model: config.model,
        ...(fetchImpl ? { fetchImpl } : {}),
        ...robustness,
      }),
    );
  }
  if (config.backend === "openai" || config.backend === "voyage") {
    // External APIs egress body text (ADR-0003); only build when a key is
    // present. Without one, degrade like `disabled` (recall → FTS) so a
    // misconfigured key never silently sends nothing or throws at query time.
    if (!config.apiKey) return null;
    const options: OpenAICompatibleEmbedderOptions = {
      baseUrl: config.baseUrl,
      model: config.model,
      apiKey: config.apiKey,
      ...(fetchImpl ? { fetchImpl } : {}),
      ...robustness,
    };
    return guard(
      config.backend === "openai" ? new OpenAIEmbedder(options) : new VoyageEmbedder(options),
    );
  }
  // disabled (default) → no embedder → recall returns the embedding_disabled
  // signal and the host falls back to FTS.
  return null;
}

/**
 * Whether an external embedding backend has an API key resolvable from the
 * keychain/env. For non-external backends (ollama/disabled) it returns `true`
 * (no key needed) so callers can pass the result straight to the config-warning
 * check, which only consults it for external backends. Used by `mcp serve` /
 * `doctor` to distinguish "openai set but no key" from "working".
 */
export async function resolveEmbeddingApiKeyPresent(
  backend: string,
  secrets: SecretStoreOptions = {},
): Promise<boolean> {
  if (!EXTERNAL_EMBEDDING_BACKENDS.has(backend as EmbeddingBackend)) return true;
  return (await resolveEmbeddingApiKey(backend, secrets)) !== null;
}

/**
 * Async wrapper over {@link createEmbedder} that resolves an external backend's
 * API key (keychain/env, ADR-0003 egress gate) before building the embedder.
 * For `ollama` / `disabled` it never touches the keychain. Use this at runtime
 * entry points (MCP boot, sync, CLI); `createEmbedder` stays available for the
 * synchronous, key-already-resolved / test paths.
 */
export async function createEmbedderResolved(
  config: Pick<EmbeddingConfig, "backend" | "baseUrl" | "model"> &
    Partial<Pick<EmbeddingConfig, "dim" | "maxBatch" | "requestTimeoutMs" | "maxRetries">>,
  options: {
    fetchImpl?: FetchLike;
    secrets?: SecretStoreOptions;
    /** Test seams threaded to the embedder's retry/backoff (no real waits). */
    sleep?: SleepLike;
    random?: () => number;
  } = {},
): Promise<Embedder | null> {
  const overrides: Pick<EmbedderRobustnessOptions, "sleep" | "random"> = {
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.random ? { random: options.random } : {}),
  };
  if (EXTERNAL_EMBEDDING_BACKENDS.has(config.backend)) {
    const apiKey = await resolveEmbeddingApiKey(config.backend, options.secrets ?? {});
    return createEmbedder({ ...config, apiKey }, options.fetchImpl, overrides);
  }
  return createEmbedder(config, options.fetchImpl, overrides);
}
