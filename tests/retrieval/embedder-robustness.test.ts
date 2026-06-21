import { describe, expect, test } from "bun:test";
import type { KeychainBackend } from "../../src/connectors/secrets.ts";
import {
  createEmbedder,
  createEmbedderResolved,
  DimensionCheckedEmbedder,
  type Embedder,
  EmbeddingError,
  type FetchLike,
  OllamaEmbedder,
  OpenAIEmbedder,
  VoyageEmbedder,
} from "../../src/retrieval/embedding/index.ts";

/** No-op sleep/random so retry/backoff never waits and jitter is deterministic. */
const noWait = { sleep: async () => {}, random: () => 0 } as const;

/** Build a fetch stub returning a fixed JSON body with the given status. */
function jsonFetch(body: unknown, status = 200): FetchLike {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
}

/** In-memory keychain stub keyed by `service account`. */
function fakeKeychain(entries: Record<string, string> = {}): KeychainBackend {
  const store = new Map(Object.entries(entries));
  return {
    get: (service, account) => store.get(`${service} ${account}`) ?? null,
    set: (service, account, value) => {
      store.set(`${service} ${account}`, value);
    },
  };
}

/**
 * Build a fake `fetch` returning queued responses in order (last one repeats).
 * Each entry is `{ status, data?, retryAfter? }`; `data` is the response body.
 */
function queuedFetch(responses: Array<{ status: number; data?: unknown; retryAfter?: string }>): {
  fetchImpl: FetchLike;
  count: () => number;
} {
  let i = 0;
  const fetchImpl: FetchLike = () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (r?.retryAfter) headers["retry-after"] = r.retryAfter;
    return Promise.resolve(
      new Response(JSON.stringify(r?.data ?? {}), { status: r?.status ?? 0, headers }),
    );
  };
  return { fetchImpl, count: () => i };
}

describe("embedder retry/backoff (Issue #267)", () => {
  test("OpenAI: 429 → retry → success (Retry-After honoured)", async () => {
    const { fetchImpl, count } = queuedFetch([
      { status: 429, retryAfter: "1" },
      { status: 200, data: { data: [{ index: 0, embedding: [1, 2] }] } },
    ]);
    const embedder = new OpenAIEmbedder({
      baseUrl: "https://api.openai.com",
      model: "m",
      apiKey: "k",
      fetchImpl,
      ...noWait,
    });
    expect(await embedder.embed(["x"])).toEqual([[1, 2]]);
    expect(count()).toBe(2);
  });

  test("Voyage: 5xx retried up to maxRetries then EmbeddingError", async () => {
    const { fetchImpl, count } = queuedFetch([{ status: 503 }]);
    const embedder = new VoyageEmbedder({
      baseUrl: "https://api.voyageai.com",
      model: "m",
      apiKey: "k",
      fetchImpl,
      maxRetries: 3,
      ...noWait,
    });
    await expect(embedder.embed(["x"])).rejects.toBeInstanceOf(EmbeddingError);
    expect(count()).toBe(3); // 3 attempts, all 503, then the final 503 → EmbeddingError
  });

  test("a non-retryable 4xx fails fast without retrying", async () => {
    const { fetchImpl, count } = queuedFetch([{ status: 401 }]);
    const embedder = new OpenAIEmbedder({
      baseUrl: "https://api.openai.com",
      model: "m",
      apiKey: "k",
      fetchImpl,
      maxRetries: 3,
      ...noWait,
    });
    await expect(embedder.embed(["x"])).rejects.toBeInstanceOf(EmbeddingError);
    expect(count()).toBe(1);
  });

  test("maxRetries=1 disables retry", async () => {
    const { fetchImpl, count } = queuedFetch([{ status: 429 }]);
    const embedder = new OpenAIEmbedder({
      baseUrl: "https://api.openai.com",
      model: "m",
      apiKey: "k",
      fetchImpl,
      maxRetries: 1,
      ...noWait,
    });
    await expect(embedder.embed(["x"])).rejects.toBeInstanceOf(EmbeddingError);
    expect(count()).toBe(1);
  });

  test("Ollama: 5xx retried then succeeds", async () => {
    const { fetchImpl, count } = queuedFetch([
      { status: 500 },
      { status: 200, data: { embeddings: [[9]] } },
    ]);
    const embedder = new OllamaEmbedder({
      baseUrl: "http://localhost:11434",
      model: "bge-m3",
      fetchImpl,
      ...noWait,
    });
    expect(await embedder.embed(["x"])).toEqual([[9]]);
    expect(count()).toBe(2);
  });
});

describe("embedder batch splitting (Issue #267)", () => {
  test("splits inputs over maxBatch into ordered chunks and preserves order", async () => {
    const chunks: string[][] = [];
    // Echo each input's first char code as a 1-dim vector so order is verifiable.
    const fetchImpl: FetchLike = (_url, init) => {
      const sent = JSON.parse(String(init?.body)) as { input: string[] };
      chunks.push(sent.input);
      const data = sent.input.map((t, idx) => ({ index: idx, embedding: [t.charCodeAt(0)] }));
      return Promise.resolve(
        new Response(JSON.stringify({ data }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };
    const embedder = new OpenAIEmbedder({
      baseUrl: "https://api.openai.com",
      model: "m",
      apiKey: "k",
      fetchImpl,
      maxBatch: 2,
      ...noWait,
    });
    const out = await embedder.embed(["a", "b", "c", "d", "e"]);
    // 5 inputs / batch 2 → chunks [a,b] [c,d] [e]
    expect(chunks).toEqual([["a", "b"], ["c", "d"], ["e"]]);
    expect(out).toEqual([[97], [98], [99], [100], [101]]);
  });

  test("Ollama splits over maxBatch too (local sidecar is still bounded)", async () => {
    const chunks: string[][] = [];
    const fetchImpl: FetchLike = (_url, init) => {
      const sent = JSON.parse(String(init?.body)) as { input: string[] };
      chunks.push(sent.input);
      return Promise.resolve(
        new Response(JSON.stringify({ embeddings: sent.input.map((t) => [t.charCodeAt(0)]) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };
    const embedder = new OllamaEmbedder({
      baseUrl: "http://localhost:11434",
      model: "bge-m3",
      fetchImpl,
      maxBatch: 2,
      ...noWait,
    });
    const out = await embedder.embed(["a", "b", "c"]);
    expect(chunks).toEqual([["a", "b"], ["c"]]);
    expect(out).toEqual([[97], [98], [99]]);
  });

  test("a single request when inputs fit within maxBatch", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = (_url, init) => {
      calls += 1;
      const sent = JSON.parse(String(init?.body)) as { input: string[] };
      const data = sent.input.map((_t, idx) => ({ index: idx, embedding: [idx] }));
      return Promise.resolve(
        new Response(JSON.stringify({ data }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };
    const embedder = new OpenAIEmbedder({
      baseUrl: "https://api.openai.com",
      model: "m",
      apiKey: "k",
      fetchImpl,
      maxBatch: 10,
      ...noWait,
    });
    await embedder.embed(["a", "b"]);
    expect(calls).toBe(1);
  });
});

describe("embedder per-request timeout (Issue #267)", () => {
  test("aborts a hung request and surfaces an EmbeddingError", async () => {
    // Never resolves until aborted by the timeout signal.
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const embedder = new OpenAIEmbedder({
      baseUrl: "https://api.openai.com",
      model: "m",
      apiKey: "k",
      fetchImpl,
      requestTimeoutMs: 1,
      maxRetries: 1, // one attempt so the abort surfaces immediately
      ...noWait,
    });
    await expect(embedder.embed(["x"])).rejects.toBeInstanceOf(EmbeddingError);
  });

  test("retries after a timeout then succeeds", async () => {
    let attempts = 0;
    const fetchImpl: FetchLike = (_url, init) => {
      attempts += 1;
      if (attempts === 1) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      return Promise.resolve(
        new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };
    const embedder = new OpenAIEmbedder({
      baseUrl: "https://api.openai.com",
      model: "m",
      apiKey: "k",
      fetchImpl,
      requestTimeoutMs: 1,
      maxRetries: 2,
      ...noWait,
    });
    expect(await embedder.embed(["x"])).toEqual([[1]]);
    expect(attempts).toBe(2);
  });
});

describe("DimensionCheckedEmbedder (Issue #267)", () => {
  /** Minimal stub embedder returning a fixed-width vector per input. */
  function stub(width: number): Embedder {
    return {
      model: "stub",
      embed: (texts) => Promise.resolve(texts.map(() => new Array(width).fill(0))),
    };
  }

  test("passes through when the model dimension matches", async () => {
    const guard = new DimensionCheckedEmbedder(stub(1024), 1024);
    expect((await guard.embed(["x"]))[0]?.length).toBe(1024);
  });

  test("fail-fasts with an actionable error on a dimension mismatch", async () => {
    const guard = new DimensionCheckedEmbedder(stub(1536), 1024);
    await expect(guard.embed(["x"])).rejects.toThrow(/1536-dim.*\[embedding\].dim is 1024/s);
  });

  test("empty input does not trigger the check (no vectors observed)", async () => {
    const guard = new DimensionCheckedEmbedder(stub(1536), 1024);
    expect(await guard.embed([])).toEqual([]);
  });

  test("preserves the inner model id and version", () => {
    const inner: Embedder = { model: "m", modelVersion: "v2", embed: () => Promise.resolve([]) };
    const guard = new DimensionCheckedEmbedder(inner, 8);
    expect(guard.model).toBe("m");
    expect(guard.modelVersion).toBe("v2");
  });

  test("createEmbedder wraps with the guard when dim is set → mismatch fails", async () => {
    const fetchImpl = jsonFetch({ data: [{ index: 0, embedding: [1, 2, 3] }] }); // 3-dim
    const embedder = createEmbedder(
      {
        backend: "openai",
        baseUrl: "https://api.openai.com",
        model: "m",
        apiKey: "k",
        dim: 1024,
      },
      fetchImpl,
      noWait,
    );
    await expect(embedder?.embed(["x"])).rejects.toThrow(/dimension mismatch/);
  });

  test("createEmbedderResolved threads dim + robustness (matching dim passes)", async () => {
    const keychain = fakeKeychain({ "suasor embedding:openai:apiKey": "sk" });
    const embedder = await createEmbedderResolved(
      { backend: "openai", baseUrl: "https://api.openai.com", model: "m", dim: 2 },
      {
        secrets: { env: {}, keychain },
        fetchImpl: jsonFetch({ data: [{ index: 0, embedding: [1, 2] }] }),
        ...noWait,
      },
    );
    expect((await embedder?.embed(["x"]))?.[0]?.length).toBe(2);
  });
});
