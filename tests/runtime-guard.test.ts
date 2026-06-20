/**
 * Bun runtime guard (src/runtime-guard.ts). The predicate is a pure function over
 * an injected version string, so CI (which always runs on Bun) can exercise the
 * "missing" / "too old" branches that it can never reach for real.
 */
import { describe, expect, test } from "bun:test";
import {
  bunVersionAtLeast,
  checkBunRuntime,
  currentBunVersion,
  MIN_BUN_VERSION,
} from "../src/runtime-guard.ts";

describe("bunVersionAtLeast", () => {
  test("equal major.minor is accepted", () => {
    expect(bunVersionAtLeast("1.1.0", "1.1")).toBe(true);
    expect(bunVersionAtLeast("1.1", "1.1")).toBe(true);
  });

  test("higher minor / major is accepted", () => {
    expect(bunVersionAtLeast("1.2.0", "1.1")).toBe(true);
    expect(bunVersionAtLeast("2.0.0", "1.1")).toBe(true);
    expect(bunVersionAtLeast("1.30.5", "1.1")).toBe(true);
  });

  test("lower minor / major is rejected", () => {
    expect(bunVersionAtLeast("1.0.30", "1.1")).toBe(false);
    expect(bunVersionAtLeast("0.8.0", "1.1")).toBe(false);
  });

  test("tolerates v-prefix and pre-release suffixes", () => {
    expect(bunVersionAtLeast("v1.1.0", "1.1")).toBe(true);
    expect(bunVersionAtLeast("1.1.30-canary.20251201", "1.1")).toBe(true);
  });

  test("unparseable version is rejected", () => {
    expect(bunVersionAtLeast("not-a-version", "1.1")).toBe(false);
    expect(bunVersionAtLeast("", "1.1")).toBe(false);
  });
});

describe("checkBunRuntime", () => {
  test("undefined (Node — no Bun global) fails with guidance, no stack", () => {
    const r = checkBunRuntime(undefined);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("requires the Bun runtime");
    expect(r.message).toContain("bunx");
    expect(r.message).toContain("https://bun.sh/install");
    // Human-readable, never a raw stack trace.
    expect(r.message).not.toContain("at Object.");
  });

  test("empty string is treated as missing", () => {
    expect(checkBunRuntime("").ok).toBe(false);
  });

  test("too-old Bun fails and names both found and required versions", () => {
    const r = checkBunRuntime("1.0.30");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("1.0.30");
    expect(r.message).toContain(MIN_BUN_VERSION);
    expect(r.message).toContain("bun upgrade");
  });

  test("recent-enough Bun passes with no message", () => {
    const r = checkBunRuntime("1.1.0");
    expect(r.ok).toBe(true);
    expect(r.message).toBeUndefined();
  });

  test("custom minimum is honoured", () => {
    expect(checkBunRuntime("1.1.0", "1.2").ok).toBe(false);
    expect(checkBunRuntime("1.2.0", "1.2").ok).toBe(true);
  });
});

describe("currentBunVersion", () => {
  test("returns the running Bun version on CI (which runs on Bun)", () => {
    // This suite runs under `bun test`, so the global Bun is present.
    expect(currentBunVersion()).toBe(Bun.version);
    expect(checkBunRuntime(currentBunVersion()).ok).toBe(true);
  });
});
