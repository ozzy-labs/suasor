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
  overrides: Partial<{
    embedding: string;
    llm: Record<string, unknown>;
    embeddingApiKeyPresent: boolean;
  }> = {},
): ConfigWarningInput {
  return {
    embedding: { backend: overrides.embedding ?? "disabled" },
    ...(overrides.llm !== undefined ? { llm: overrides.llm } : {}),
    ...(overrides.embeddingApiKeyPresent !== undefined
      ? { embeddingApiKeyPresent: overrides.embeddingApiKeyPresent }
      : {}),
  };
}

describe("collectConfigWarnings", () => {
  test("no warnings for implemented / inert values (ollama, disabled)", () => {
    expect(collectConfigWarnings(input({ embedding: "ollama" }))).toEqual([]);
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

  test("tells the operator to delete a retired [llm] section", () => {
    const warnings = collectConfigWarnings(input({ llm: { backend: "anthropic" } }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.key).toBe("llm");
    // The point is deletion, not "your value was ignored" — no value here was
    // ever honoured, so naming the backend would imply it nearly worked.
    expect(warnings[0]?.message).toContain("retired");
    expect(warnings[0]?.message).toContain("the host is the LLM");
  });

  test("fires on an empty [llm] table too — presence is the trigger", () => {
    // `[llm]` alone (or the old template's `backend = "disabled"`) is still a
    // dead section to remove; keying on a non-default value would leave the
    // most common leftover unreported.
    expect(collectConfigWarnings(input({ llm: {} }))).toHaveLength(1);
  });

  test("says nothing when the section is absent", () => {
    expect(collectConfigWarnings(input())).toEqual([]);
  });

  test("collects both warnings in a stable order (embedding before llm)", () => {
    const warnings = collectConfigWarnings(
      input({ embedding: "voyage", llm: { backend: "anthropic" } }),
    );
    expect(warnings.map((w) => w.key)).toEqual(["embedding.backend", "llm"]);
  });
});

describe("collectConfigWarnings — remote sidecar disclosure (Issue #436)", () => {
  test("discloses a remote (non-loopback) composition sidecar", () => {
    const warnings = collectConfigWarnings({
      embedding: { backend: "disabled" },
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
      extraction: { backend: "markitdown", baseUrl: "http://sidecar:8929", allowRemote: true },
    });
    expect(extraction.map((w) => w.key)).toEqual(["extraction.baseUrl"]);

    const embedding = collectConfigWarnings({
      embedding: { backend: "ollama", baseUrl: "http://sidecar:11434", allowRemote: true },
    });
    expect(embedding.map((w) => w.key)).toEqual(["embedding.baseUrl"]);
  });

  test("does not disclose a loopback sidecar (local, no egress)", () => {
    expect(
      collectConfigWarnings({
        embedding: { backend: "ollama", baseUrl: "http://localhost:11434" },
        extraction: { backend: "markitdown", baseUrl: "http://127.0.0.1:8929" },
        export: { composition: { backend: "pandoc", baseUrl: "http://localhost:8930" } },
      }),
    ).toEqual([]);
  });

  test("a remote openai baseUrl is not a sidecar disclosure (only the key warning)", () => {
    const warnings = collectConfigWarnings({
      embedding: { backend: "openai", baseUrl: "https://api.openai.com" },
    });
    // Only the existing external-backend key-readiness warning, no *.baseUrl entry.
    expect(warnings.map((w) => w.key)).toEqual(["embedding.backend"]);
  });

  test("orders sidecar disclosures after the embedding / llm entries, in config order", () => {
    const warnings = collectConfigWarnings({
      embedding: { backend: "ollama", baseUrl: "http://sidecar:11434", allowRemote: true },
      llm: { backend: "anthropic" },
      extraction: { backend: "markitdown", baseUrl: "http://sidecar:8929", allowRemote: true },
      export: {
        composition: { backend: "pandoc", baseUrl: "http://sidecar:8930", allowRemote: true },
      },
    });
    expect(warnings.map((w) => w.key)).toEqual([
      "llm",
      "embedding.baseUrl",
      "extraction.baseUrl",
      "export.composition.baseUrl",
    ]);
  });
});
