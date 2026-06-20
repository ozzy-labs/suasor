/**
 * CLI startup Bun version guard (src/index.ts uses src/runtime-guard.ts).
 *
 * The CLI is supposed to fail fast with a human-readable message and exit 1 when
 * Bun is missing or below the minimum, instead of the opaque
 * `ERR_UNSUPPORTED_ESM_URL_SCHEME` that `bun:sqlite` throws under Node. CI always
 * runs on Bun, so the guard predicate is injected with synthetic version strings
 * (the version-string injection the test plan calls for).
 */
import { describe, expect, test } from "bun:test";
import { checkBunRuntime, MIN_BUN_VERSION } from "../../src/runtime-guard.ts";

describe("CLI startup Bun version guard", () => {
  test("below the minimum version → not ok, human-readable, no stack trace", () => {
    const r = checkBunRuntime("1.0.99", MIN_BUN_VERSION);
    expect(r.ok).toBe(false);
    // Human-readable: names what was found and what is required.
    expect(r.message).toContain("1.0.99");
    expect(r.message).toContain(MIN_BUN_VERSION);
    // No raw stack trace leaks into the message.
    expect(r.message).not.toMatch(/\n\s*at .+:\d+:\d+/);
  });

  test("missing Bun → not ok with install guidance", () => {
    const r = checkBunRuntime(undefined, MIN_BUN_VERSION);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Bun");
    expect(r.message).toContain("install.md");
  });

  test("at the minimum version → ok (CLI proceeds)", () => {
    expect(checkBunRuntime("1.1.0", MIN_BUN_VERSION).ok).toBe(true);
  });
});
