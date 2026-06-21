import { describe, expect, test } from "bun:test";
import { type ConfigWarningInput, collectConfigWarnings } from "../../src/config/index.ts";

/**
 * Unit tests for the "accepted but silently dropped" config warning check
 * (Issue #235, ADR-0007 silent-error eradication). The degrade behavior is
 * unchanged; these assert only that the no-op is surfaced as a warning.
 */

/** A baseline input with everything implemented / inert (no warnings expected). */
function input(overrides: Partial<{ embedding: string; llm: string }> = {}): ConfigWarningInput {
  return {
    embedding: { backend: overrides.embedding ?? "disabled" },
    llm: { backend: overrides.llm ?? "disabled" },
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
    test(`warns when embedding.backend = ${backend} (unimplemented → FTS fallback)`, () => {
      const warnings = collectConfigWarnings(input({ embedding: backend }));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.key).toBe("embedding.backend");
      expect(warnings[0]?.message).toContain(backend);
      expect(warnings[0]?.message).toContain("FTS");
    });
  }

  test("does not warn for embedding.backend = ollama (implemented)", () => {
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
