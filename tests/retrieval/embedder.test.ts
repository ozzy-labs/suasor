import { describe, expect, test } from "bun:test";
import {
  createEmbedder,
  EmbeddingError,
  type FetchLike,
  OllamaEmbedder,
} from "../../src/retrieval/embedding/index.ts";

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

describe("OllamaEmbedder", () => {
  test("POSTs to /api/embed with model + input and returns embeddings", async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    const fetchImpl: FetchLike = (url, init) => {
      captured = { url, init };
      return Promise.resolve(
        new Response(JSON.stringify({ embeddings: [[1, 2, 3]] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };
    const embedder = new OllamaEmbedder({
      baseUrl: "http://localhost:11434",
      model: "bge-m3",
      fetchImpl,
    });
    const vectors = await embedder.embed(["hello"]);

    expect(vectors).toEqual([[1, 2, 3]]);
    expect(captured?.url).toBe("http://localhost:11434/api/embed");
    expect(captured?.init?.method).toBe("POST");
    const sent = JSON.parse(String(captured?.init?.body)) as { model: string; input: string[] };
    expect(sent.model).toBe("bge-m3");
    expect(sent.input).toEqual(["hello"]);
  });

  test("trims a trailing slash on the base URL", async () => {
    let url = "";
    const embedder = new OllamaEmbedder({
      baseUrl: "http://localhost:11434/",
      model: "bge-m3",
      fetchImpl: (u) => {
        url = u;
        return Promise.resolve(
          new Response(JSON.stringify({ embeddings: [[0]] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      },
    });
    await embedder.embed(["x"]);
    expect(url).toBe("http://localhost:11434/api/embed");
  });

  test("returns batched vectors in input order", async () => {
    const embedder = new OllamaEmbedder({
      baseUrl: "http://localhost:11434",
      model: "bge-m3",
      fetchImpl: jsonFetch({ embeddings: [[1], [2], [3]] }),
    });
    expect(await embedder.embed(["a", "b", "c"])).toEqual([[1], [2], [3]]);
  });

  test("empty input makes no request and returns []", async () => {
    let called = false;
    const embedder = new OllamaEmbedder({
      baseUrl: "http://localhost:11434",
      model: "bge-m3",
      fetchImpl: () => {
        called = true;
        return Promise.resolve(new Response("{}"));
      },
    });
    expect(await embedder.embed([])).toEqual([]);
    expect(called).toBe(false);
  });

  test("throws EmbeddingError on a non-2xx response", async () => {
    const embedder = new OllamaEmbedder({
      baseUrl: "http://localhost:11434",
      model: "bge-m3",
      fetchImpl: jsonFetch({ error: "boom" }, 500),
    });
    await expect(embedder.embed(["x"])).rejects.toBeInstanceOf(EmbeddingError);
  });

  test("throws EmbeddingError when the network call fails", async () => {
    const embedder = new OllamaEmbedder({
      baseUrl: "http://localhost:11434",
      model: "bge-m3",
      fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")),
    });
    await expect(embedder.embed(["x"])).rejects.toBeInstanceOf(EmbeddingError);
  });

  test("throws EmbeddingError when the vector count mismatches the input count", async () => {
    const embedder = new OllamaEmbedder({
      baseUrl: "http://localhost:11434",
      model: "bge-m3",
      fetchImpl: jsonFetch({ embeddings: [[1]] }),
    });
    await expect(embedder.embed(["a", "b"])).rejects.toBeInstanceOf(EmbeddingError);
  });
});

describe("createEmbedder", () => {
  test("builds an OllamaEmbedder for backend=ollama with the configured model", () => {
    const embedder = createEmbedder({
      backend: "ollama",
      baseUrl: "http://localhost:11434",
      model: "bge-m3",
    });
    expect(embedder).toBeInstanceOf(OllamaEmbedder);
    expect(embedder?.model).toBe("bge-m3");
  });

  test("returns null for backend=disabled (graceful degrade)", () => {
    expect(
      createEmbedder({ backend: "disabled", baseUrl: "http://localhost:11434", model: "bge-m3" }),
    ).toBeNull();
  });

  test("returns null for not-yet-implemented backends (openai/voyage)", () => {
    for (const backend of ["openai", "voyage"] as const) {
      expect(
        createEmbedder({ backend, baseUrl: "http://localhost:11434", model: "bge-m3" }),
      ).toBeNull();
    }
  });
});
