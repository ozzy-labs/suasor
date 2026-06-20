/**
 * Build-target detection + standalone gate (src/cli/build-target.ts, Issue
 * #167). The predicates are pure over an injected `Bun.main` value / `isBinary`
 * flag, so CI (which never runs as a compiled binary) can exercise the binary
 * branch it can't reach for real.
 */
import { describe, expect, test } from "bun:test";
import {
  BINARY_SCOPE_DOC,
  binaryUnsupportedMessage,
  currentBuildIsBinary,
  FORCE_BINARY_ENV,
  isStandaloneBinary,
  standaloneGate,
} from "../../src/cli/build-target.ts";

describe("isStandaloneBinary", () => {
  test("compiled-binary virtual fs roots are detected", () => {
    expect(isStandaloneBinary("/$bunfs/root/suasor")).toBe(true);
    expect(isStandaloneBinary("B:\\~BUN\\root\\suasor.exe")).toBe(true);
    expect(isStandaloneBinary("C:/~BUN/root/suasor.exe")).toBe(true);
  });

  test("normal on-disk entry paths are not the binary", () => {
    expect(isStandaloneBinary("/home/me/proj/src/index.ts")).toBe(false);
    expect(isStandaloneBinary("file:///tmp/index.ts")).toBe(false);
  });

  test("missing main is not the binary", () => {
    expect(isStandaloneBinary(undefined)).toBe(false);
    expect(isStandaloneBinary("")).toBe(false);
  });
});

describe("currentBuildIsBinary — env override", () => {
  test("forced on / off via the env seam", () => {
    expect(currentBuildIsBinary({ [FORCE_BINARY_ENV]: "1" })).toBe(true);
    expect(currentBuildIsBinary({ [FORCE_BINARY_ENV]: "true" })).toBe(true);
    expect(currentBuildIsBinary({ [FORCE_BINARY_ENV]: "0" })).toBe(false);
    expect(currentBuildIsBinary({ [FORCE_BINARY_ENV]: "false" })).toBe(false);
  });

  test("unset falls back to the Bun.main probe (false under bun test)", () => {
    expect(currentBuildIsBinary({})).toBe(false);
  });
});

describe("binaryUnsupportedMessage", () => {
  test("names the feature and links the binary-scope doc", () => {
    const msg = binaryUnsupportedMessage(
      "'skills install' (the bundled docs/skills are not shipped)",
    );
    expect(msg).toContain("not available in the standalone binary");
    expect(msg).toContain("'skills install'");
    expect(msg).toContain(BINARY_SCOPE_DOC);
    expect(msg.endsWith("\n")).toBe(true);
    // Human-readable — never a raw stack trace.
    expect(msg).not.toContain("at Object.");
  });

  test("appends the escape-hatch hint when given", () => {
    const msg = binaryUnsupportedMessage(
      "'box auth set'",
      "set SUASOR_CONNECTOR_BOX_TOKEN=<value>",
    );
    expect(msg).toContain("hint: set SUASOR_CONNECTOR_BOX_TOKEN=<value>");
  });
});

describe("standaloneGate", () => {
  test("passes through on a normal build", () => {
    expect(standaloneGate("'x'", { isBinary: false })).toEqual({ ok: true });
  });

  test("blocks with a message in the binary", () => {
    const r = standaloneGate("'x'", { isBinary: true, hint: "do y" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("not available in the standalone binary");
      expect(r.message).toContain("hint: do y");
    }
  });
});
