import { expect, test } from "bun:test";
import pkg from "../package.json" with { type: "json" };
import { VERSION } from "../src/index.ts";

test("scaffold smoke: VERSION tracks package.json (single source of truth)", () => {
  expect(VERSION).toBe(pkg.version);
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
});
