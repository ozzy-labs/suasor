import { describe, expect, test } from "bun:test";
import { type ConfigWarningInput, collectConfigWarnings } from "../../src/config/index.ts";
import { docsUrl } from "../../src/shared/doc-ref.ts";

/**
 * Unit tests for the "accepted but silently dropped" config warning check
 * (Issue #235, ADR-0007 silent-error eradication). The degrade behavior is
 * unchanged; these assert only that the no-op is surfaced as a warning.
 */

/** A baseline input with everything implemented / inert (no warnings expected). */
function input(
  overrides: Partial<{ embedding: string; llm: string; embeddingApiKeyPresent: boolean }> = {},
): ConfigWarningInput {
  return {
    embedding: { backend: overrides.embedding ?? "disabled" },
    llm: { backend: overrides.llm ?? "disabled" },
    ...(overrides.embeddingApiKeyPresent !== undefined
      ? { embeddingApiKeyPresent: overrides.embeddingApiKeyPresent }
      : {}),
  };
}

describe("collectConfigWarnings", () => {
  test("no warnings for implemented / inert values (ollama, disabled)", () => {
    expect(collectConfigWarnings(input({ embedding: "ollama", llm: "disabled" }))).toEqual([]);
  });

  test("no warnings for the all-disabled default", () => {
    expect(collectConfigWarnings(input())).toEqual([]);
  });

  for (const backend of ["openai", "voyage"] as const) {
    test(`warns when embedding.backend = ${backend} with no API key (→ FTS fallback)`, () => {
      const warnings = collectConfigWarnings(input({ embedding: backend }));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.key).toBe("embedding.backend");
      expect(warnings[0]?.message).toContain(backend);
      expect(warnings[0]?.message).toContain("API key");
      expect(warnings[0]?.message).toContain(`SUASOR_EMBEDDING_${backend.toUpperCase()}_API_KEY`);
      // Doc pointer is a followable URL (Issue #396), not a repo-relative path.
      expect(warnings[0]?.message).toContain(docsUrl("guide/embedding.md"));
    });

    test(`does not warn when embedding.backend = ${backend} and an API key is present`, () => {
      expect(
        collectConfigWarnings(input({ embedding: backend, embeddingApiKeyPresent: true })),
      ).toEqual([]);
    });

    test(`warns when embedding.backend = ${backend} and embeddingApiKeyPresent is false`, () => {
      const warnings = collectConfigWarnings(
        input({ embedding: backend, embeddingApiKeyPresent: false }),
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.key).toBe("embedding.backend");
    });
  }

  test("does not warn for embedding.backend = ollama (implemented, no key needed)", () => {
    expect(collectConfigWarnings(input({ embedding: "ollama" }))).toEqual([]);
  });

  for (const backend of ["anthropic", "openai", "ollama"] as const) {
    test(`warns when [llm].backend = ${backend} (set but unused at runtime)`, () => {
      const warnings = collectConfigWarnings(input({ llm: backend }));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.key).toBe("llm.backend");
      expect(warnings[0]?.message).toContain(backend);
    });
  }

  test("does not warn for [llm].backend = disabled (default, nothing dropped)", () => {
    expect(collectConfigWarnings(input({ llm: "disabled" }))).toEqual([]);
  });

  test("collects both warnings in a stable order (embedding before llm)", () => {
    const warnings = collectConfigWarnings(input({ embedding: "voyage", llm: "anthropic" }));
    expect(warnings.map((w) => w.key)).toEqual(["embedding.backend", "llm.backend"]);
  });
});

describe("collectConfigWarnings — remote sidecar disclosure (Issue #436)", () => {
  test("discloses a remote (non-loopback) composition sidecar", () => {
    const warnings = collectConfigWarnings({
      embedding: { backend: "disabled" },
      llm: { backend: "disabled" },
      export: {
        composition: {
          backend: "pandoc",
          baseUrl: "https://compose.example.com",
          allowRemote: true,
        },
      },
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.key).toBe("export.composition.baseUrl");
    expect(warnings[0]?.message).toContain("https://compose.example.com");
    expect(warnings[0]?.message).toContain("remote");
    expect(warnings[0]?.message).toContain("export.composition.allowRemote");
  });

  test("discloses remote extraction and ollama embedding sidecars", () => {
    const extraction = collectConfigWarnings({
      embedding: { backend: "disabled" },
      llm: { backend: "disabled" },
      extraction: { backend: "markitdown", baseUrl: "http://sidecar:8929", allowRemote: true },
    });
    expect(extraction.map((w) => w.key)).toEqual(["extraction.baseUrl"]);

    const embedding = collectConfigWarnings({
      embedding: { backend: "ollama", baseUrl: "http://sidecar:11434", allowRemote: true },
      llm: { backend: "disabled" },
    });
    expect(embedding.map((w) => w.key)).toEqual(["embedding.baseUrl"]);
  });

  test("does not disclose a loopback sidecar (local, no egress)", () => {
    expect(
      collectConfigWarnings({
        embedding: { backend: "ollama", baseUrl: "http://localhost:11434" },
        llm: { backend: "disabled" },
        extraction: { backend: "markitdown", baseUrl: "http://127.0.0.1:8929" },
        export: { composition: { backend: "pandoc", baseUrl: "http://localhost:8930" } },
      }),
    ).toEqual([]);
  });

  test("a remote openai baseUrl is not a sidecar disclosure (only the key warning)", () => {
    const warnings = collectConfigWarnings({
      embedding: { backend: "openai", baseUrl: "https://api.openai.com" },
      llm: { backend: "disabled" },
    });
    // Only the existing external-backend key-readiness warning, no *.baseUrl entry.
    expect(warnings.map((w) => w.key)).toEqual(["embedding.backend"]);
  });

  test("orders sidecar disclosures after embedding/llm, in config order", () => {
    const warnings = collectConfigWarnings({
      embedding: { backend: "ollama", baseUrl: "http://sidecar:11434", allowRemote: true },
      llm: { backend: "anthropic" },
      extraction: { backend: "markitdown", baseUrl: "http://sidecar:8929", allowRemote: true },
      export: {
        composition: { backend: "pandoc", baseUrl: "http://sidecar:8930", allowRemote: true },
      },
    });
    expect(warnings.map((w) => w.key)).toEqual([
      "llm.backend",
      "embedding.baseUrl",
      "extraction.baseUrl",
      "export.composition.baseUrl",
    ]);
  });
});
