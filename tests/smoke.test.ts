import { expect, test } from "bun:test";
import { VERSION } from "../src/index.ts";

test("scaffold smoke", () => {
  expect(VERSION).toBe("0.0.0");
});
