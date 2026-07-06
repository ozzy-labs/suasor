/**
 * Reference extraction sidecar (ADR-0024, Issue #439). Exercises the markitdown
 * shim via an injected runner (no live markitdown / no real subprocess): the
 * extension gate, the exit-code → outcome mapping, the missing-binary structured
 * error, the HTTP handler contract, the bind-address resolver, and one live
 * Bun.serve round-trip on an ephemeral port.
 */
import { describe, expect, test } from "bun:test";
import {
  createExtractHandler,
  DEFAULT_MARKITDOWN_COMMAND,
  MARKITDOWN_INSTALL_HINT,
  type MarkitdownRun,
  type MarkitdownRunResult,
  probeMarkitdown,
  resolveServeAddress,
  runExtraction,
  startExtractionServer,
} from "../../src/extraction/serve.ts";

const bytes = new TextEncoder().encode("binary-docx-bytes");

/** A runner that records its args and returns a fixed result. */
function stubRun(
  result: Partial<MarkitdownRunResult>,
  record?: { command?: string; args?: string[] },
): MarkitdownRun {
  return (command, args) => {
    if (record) {
      record.command = command;
      record.args = args;
    }
    return Promise.resolve({
      code: 0,
      stdout: "",
      stderr: "",
      notFound: false,
      ...result,
    });
  };
}

describe("runExtraction", () => {
  test("extracts text on a clean markitdown exit", async () => {
    const rec: { args?: string[] } = {};
    const outcome = await runExtraction(bytes, "design.docx", {
      run: stubRun({ code: 0, stdout: "# Title\n\nbody" }, rec),
    });
    expect(outcome).toEqual({ kind: "text", text: "# Title\n\nbody" });
    // The temp file passed to markitdown keeps the source extension (dispatch by format).
    expect(rec.args?.[0]).toMatch(/\.docx$/);
  });

  test("short-circuits to unsupported for a non-extractable extension (no spawn)", async () => {
    let spawned = false;
    const outcome = await runExtraction(bytes, "photo.heic", {
      run: () => {
        spawned = true;
        return Promise.resolve({ code: 0, stdout: "x", stderr: "", notFound: false });
      },
    });
    expect(outcome).toEqual({ kind: "unsupported" });
    expect(spawned).toBe(false);
  });

  test("maps a non-zero markitdown exit to a failed outcome", async () => {
    const outcome = await runExtraction(bytes, "a.pdf", {
      run: stubRun({ code: 1, stderr: "conversion boom" }),
    });
    expect(outcome).toEqual({ kind: "failed", detail: "conversion boom" });
  });

  test("maps a missing binary (notFound) to not-installed", async () => {
    const outcome = await runExtraction(bytes, "a.pdf", {
      run: stubRun({ notFound: true, code: -1 }),
    });
    expect(outcome).toEqual({ kind: "not-installed" });
  });

  test("all four extractable extensions dispatch by format", async () => {
    for (const ext of [".docx", ".xlsx", ".pptx", ".pdf"]) {
      const rec: { args?: string[] } = {};
      const outcome = await runExtraction(bytes, `f${ext}`, {
        run: stubRun({ code: 0, stdout: "ok" }, rec),
      });
      expect(outcome).toEqual({ kind: "text", text: "ok" });
      expect(rec.args?.[0]?.endsWith(ext)).toBe(true);
    }
  });
});

describe("probeMarkitdown", () => {
  test("true when the binary is present", async () => {
    const rec: { args?: string[] } = {};
    expect(await probeMarkitdown({ run: stubRun({ notFound: false }, rec) })).toBe(true);
    expect(rec.args).toEqual(["--version"]);
  });

  test("false when the binary is missing", async () => {
    expect(await probeMarkitdown({ run: stubRun({ notFound: true }) })).toBe(false);
  });
});

describe("createExtractHandler", () => {
  const post = (filename: string, deps = {}) =>
    createExtractHandler(deps)(
      new Request("http://localhost/extract", {
        method: "POST",
        headers: { "x-filename": encodeURIComponent(filename) },
        body: bytes,
      }),
    );

  test("POST /extract returns { text } on success", async () => {
    const res = await post("a.docx", { run: stubRun({ code: 0, stdout: "hello" }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "hello" });
  });

  test("POST /extract returns { text: null } for an unsupported format", async () => {
    const res = await post("a.heic", { run: stubRun({ code: 0, stdout: "x" }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: null });
  });

  test("POST /extract returns 500 on a markitdown failure", async () => {
    const res = await post("a.pdf", { run: stubRun({ code: 1, stderr: "bad file" }) });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "extraction_failed", detail: "bad file" });
  });

  test("POST /extract returns 503 with install guidance when markitdown is absent", async () => {
    const res = await post("a.pdf", { run: stubRun({ notFound: true }) });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; install: string[] };
    expect(body.error).toBe(MARKITDOWN_INSTALL_HINT.code);
    expect(body.install).toEqual([...MARKITDOWN_INSTALL_HINT.install]);
  });

  test("GET /health is a readiness probe", async () => {
    const res = await createExtractHandler()(new Request("http://localhost/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("any other route is 404", async () => {
    const res = await createExtractHandler()(
      new Request("http://localhost/extract", { method: "GET" }),
    );
    expect(res.status).toBe(404);
  });
});

describe("resolveServeAddress", () => {
  test("derives host/port from the default baseUrl", () => {
    expect(resolveServeAddress("http://localhost:8929")).toEqual({
      host: "localhost",
      port: 8929,
    });
  });

  test("--port / --host overrides win", () => {
    expect(resolveServeAddress("http://localhost:8929", "127.0.0.1", "9000")).toEqual({
      host: "127.0.0.1",
      port: 9000,
    });
  });

  test("falls back to the scheme default port when baseUrl omits one", () => {
    expect(resolveServeAddress("https://sidecar.example")).toEqual({
      host: "sidecar.example",
      port: 443,
    });
  });

  test("rejects an out-of-range --port", () => {
    expect(resolveServeAddress("http://localhost:8929", undefined, "70000")).toEqual({
      error: "--port must be an integer in [1, 65535]",
    });
  });

  test("rejects a non-integer --port", () => {
    expect(resolveServeAddress("http://localhost:8929", undefined, "abc")).toEqual({
      error: "--port must be an integer in [1, 65535]",
    });
  });

  test("rejects an unparseable baseUrl", () => {
    const out = resolveServeAddress("not a url");
    expect("error" in out).toBe(true);
  });
});

describe("install hint + defaults", () => {
  test("the install hint lists concrete markitdown commands", () => {
    expect(DEFAULT_MARKITDOWN_COMMAND).toBe("markitdown");
    expect(MARKITDOWN_INSTALL_HINT.install.length).toBeGreaterThan(0);
    expect(MARKITDOWN_INSTALL_HINT.install.every((s) => s.includes("markitdown"))).toBe(true);
  });
});

describe("startExtractionServer (live Bun.serve, ephemeral port)", () => {
  test("serves the extraction contract end to end", async () => {
    const server = startExtractionServer({
      host: "127.0.0.1",
      port: 0, // ephemeral
      deps: { run: stubRun({ code: 0, stdout: "# From sidecar" }) },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/extract`, {
        method: "POST",
        headers: { "x-filename": encodeURIComponent("spec.docx") },
        body: bytes,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ text: "# From sidecar" });
    } finally {
      server.stop();
    }
  });
});
