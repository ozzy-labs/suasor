import { describe, expect, test } from "bun:test";
import { McpToolError, toolError, toToolError, verifyReadiness } from "../../src/mcp/errors.ts";

/**
 * Unit tests for the structured MCP error helpers (ADR-0031). The server-level
 * wiring is covered in server.test.ts / serve.test.ts; this pins the building
 * blocks (body shape, error mapping, readiness verification).
 */

describe("toolError", () => {
  test("wraps a body into an isError result with the JSON as the text block", () => {
    const res = toolError({ code: "INVALID_INPUT", message: "bad", hint: "fix it" });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.type).toBe("text");
    expect(JSON.parse(res.content[0]?.text ?? "")).toEqual({
      code: "INVALID_INPUT",
      message: "bad",
      hint: "fix it",
    });
  });

  test("omits an absent hint from the serialized body", () => {
    const res = toolError({ code: "MISSING_ENTITY", message: "gone" });
    const body = JSON.parse(res.content[0]?.text ?? "");
    expect(body).toEqual({ code: "MISSING_ENTITY", message: "gone" });
    expect("hint" in body).toBe(false);
  });
});

describe("McpToolError", () => {
  test("body() carries code/message/hint", () => {
    const e = new McpToolError("CONFIG_INVALID", "no db", "set dbPath");
    expect(e.body()).toEqual({ code: "CONFIG_INVALID", message: "no db", hint: "set dbPath" });
    expect(e).toBeInstanceOf(Error);
  });
});

describe("toToolError", () => {
  test("keeps a McpToolError's code + hint", () => {
    const res = toToolError(new McpToolError("INVALID_STATE", "not open", "list first"));
    expect(JSON.parse(res.content[0]?.text ?? "")).toEqual({
      code: "INVALID_STATE",
      message: "not open",
      hint: "list first",
    });
  });

  test("degrades a plain Error to INTERNAL", () => {
    const res = toToolError(new Error("boom"));
    expect(JSON.parse(res.content[0]?.text ?? "")).toEqual({ code: "INTERNAL", message: "boom" });
  });

  test("stringifies a non-Error throw as INTERNAL", () => {
    const res = toToolError("weird");
    expect(JSON.parse(res.content[0]?.text ?? "")).toEqual({ code: "INTERNAL", message: "weird" });
  });
});

describe("verifyReadiness", () => {
  test("is ready (no issues) when dbPath is set", () => {
    expect(verifyReadiness({ storage: { dbPath: "/tmp/suasor.db" } })).toEqual([]);
  });

  test("flags a null dbPath as a fatal CONFIG_INVALID with a hint", () => {
    const issues = verifyReadiness({ storage: { dbPath: null } });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("CONFIG_INVALID");
    expect(issues[0]?.hint).toBeTruthy();
  });
});
