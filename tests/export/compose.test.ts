/**
 * Composition sidecar client (#138, md→Office). Verifies disabled→null, the
 * pandoc happy path (bytes), and transport/protocol failures → ComposeError.
 * No live sidecar: `fetch` is injected.
 */
import { describe, expect, test } from "bun:test";
import { Config } from "../../src/config/schema.ts";
import { ComposeError, createComposer, PandocComposer } from "../../src/export/compose.ts";

function stubFetch(handler: (input: string, init?: RequestInit) => Response | Promise<Response>) {
  return (input: string, init?: RequestInit) => Promise.resolve(handler(input, init));
}

describe("config: [export].composition defaults", () => {
  test("defaults to disabled", () => {
    const c = Config.parse({});
    expect(c.export.composition.backend).toBe("disabled");
    expect(c.export.composition.baseUrl).toMatch(/^https?:\/\//);
  });
});

describe("createComposer", () => {
  test("returns null when disabled", () => {
    expect(createComposer({ backend: "disabled", baseUrl: "http://x" })).toBeNull();
  });
  test("builds a PandocComposer when backend is pandoc", () => {
    expect(createComposer({ backend: "pandoc", baseUrl: "http://localhost:8930" })).toBeInstanceOf(
      PandocComposer,
    );
  });
});

describe("PandocComposer.compose", () => {
  test("posts content+format and returns the response bytes", async () => {
    let seenUrl = "";
    let seenBody = "";
    const composer = new PandocComposer({
      baseUrl: "http://localhost:8930",
      fetchImpl: stubFetch((url, init) => {
        seenUrl = url;
        seenBody = String(init?.body);
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }),
    });
    const bytes = await composer.compose("# Hi", "docx");
    expect(seenUrl).toBe("http://localhost:8930/compose");
    expect(JSON.parse(seenBody)).toEqual({ content: "# Hi", format: "docx" });
    expect([...bytes]).toEqual([1, 2, 3]);
  });

  test("raises ComposeError on a non-2xx response", async () => {
    const composer = new PandocComposer({
      baseUrl: "http://x",
      fetchImpl: stubFetch(() => new Response("nope", { status: 422 })),
    });
    await expect(composer.compose("x", "pptx")).rejects.toBeInstanceOf(ComposeError);
  });

  test("raises ComposeError when the request throws (sidecar down)", async () => {
    const composer = new PandocComposer({
      baseUrl: "http://x",
      fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")),
    });
    await expect(composer.compose("x", "docx")).rejects.toBeInstanceOf(ComposeError);
  });
});
