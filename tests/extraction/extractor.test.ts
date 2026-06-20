/**
 * Document-extraction thin client (ADR-0024). Verifies graceful degradation
 * (disabled → null), the markitdown sidecar happy path, unsupported-format
 * (`text: null` → null), and transport/protocol failures → ExtractionError.
 * No live sidecar: `fetch` is injected.
 */
import { describe, expect, test } from "bun:test";
import { Config, ExtractionConfig } from "../../src/config/schema.ts";
import {
  createExtractor,
  ExtractionError,
  MarkitdownExtractor,
} from "../../src/extraction/index.ts";

/** A fetch stub returning a fixed Response (or throwing for network errors). */
function stubFetch(handler: (input: string, init?: RequestInit) => Response | Promise<Response>) {
  return (input: string, init?: RequestInit) => Promise.resolve(handler(input, init));
}

const bytes = new TextEncoder().encode("binary-docx-bytes");

describe("config: [extraction] defaults", () => {
  test("defaults to disabled when the section is omitted", () => {
    const config = Config.parse({});
    expect(config.extraction.backend).toBe("disabled");
    expect(config.extraction.maxBytes).toBeGreaterThan(0);
    expect(config.extraction.baseUrl).toMatch(/^https?:\/\//);
  });

  test("accepts an enabled markitdown backend", () => {
    const ex = ExtractionConfig.parse({ backend: "markitdown", baseUrl: "http://localhost:9000" });
    expect(ex.backend).toBe("markitdown");
    expect(ex.baseUrl).toBe("http://localhost:9000");
  });
});

describe("createExtractor", () => {
  test("returns null when the backend is disabled (graceful degradation)", () => {
    expect(createExtractor({ backend: "disabled", baseUrl: "http://x" })).toBeNull();
  });

  test("builds a MarkitdownExtractor when backend is markitdown", () => {
    const ex = createExtractor({ backend: "markitdown", baseUrl: "http://localhost:8929" });
    expect(ex).toBeInstanceOf(MarkitdownExtractor);
  });
});

describe("MarkitdownExtractor.extract", () => {
  test("returns extracted text on a 200 response", async () => {
    let seenUrl = "";
    let seenFilename: string | undefined;
    const ex = new MarkitdownExtractor({
      baseUrl: "http://localhost:8929",
      fetchImpl: stubFetch((url, init) => {
        seenUrl = url;
        seenFilename = (init?.headers as Record<string, string>)["x-filename"];
        return new Response(JSON.stringify({ text: "# Title\n\nbody" }), { status: 200 });
      }),
    });
    const text = await ex.extract(bytes, "design.docx");
    expect(text).toBe("# Title\n\nbody");
    expect(seenUrl).toBe("http://localhost:8929/extract");
    expect(seenFilename).toBe(encodeURIComponent("design.docx"));
  });

  test("trims a trailing slash on baseUrl", async () => {
    let seenUrl = "";
    const ex = new MarkitdownExtractor({
      baseUrl: "http://localhost:8929/",
      fetchImpl: stubFetch((url) => {
        seenUrl = url;
        return new Response(JSON.stringify({ text: "ok" }), { status: 200 });
      }),
    });
    await ex.extract(bytes, "a.pdf");
    expect(seenUrl).toBe("http://localhost:8929/extract");
  });

  test("returns null when the sidecar reports an unsupported format (text: null)", async () => {
    const ex = new MarkitdownExtractor({
      baseUrl: "http://x",
      fetchImpl: stubFetch(() => new Response(JSON.stringify({ text: null }), { status: 200 })),
    });
    expect(await ex.extract(bytes, "image.heic")).toBeNull();
  });

  test("raises ExtractionError on a non-2xx response", async () => {
    const ex = new MarkitdownExtractor({
      baseUrl: "http://x",
      fetchImpl: stubFetch(() => new Response("boom", { status: 500 })),
    });
    await expect(ex.extract(bytes, "a.docx")).rejects.toBeInstanceOf(ExtractionError);
  });

  test("raises ExtractionError when the request throws (sidecar down)", async () => {
    const ex = new MarkitdownExtractor({
      baseUrl: "http://x",
      fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")),
    });
    await expect(ex.extract(bytes, "a.docx")).rejects.toBeInstanceOf(ExtractionError);
  });

  test("raises ExtractionError on a non-JSON body", async () => {
    const ex = new MarkitdownExtractor({
      baseUrl: "http://x",
      fetchImpl: stubFetch(() => new Response("not json", { status: 200 })),
    });
    await expect(ex.extract(bytes, "a.docx")).rejects.toBeInstanceOf(ExtractionError);
  });
});
