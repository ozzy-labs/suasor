import { describe, expect, test } from "bun:test";
import { type ConfigWarningInput, collectConfigWarnings } from "../../src/config/index.ts";

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
