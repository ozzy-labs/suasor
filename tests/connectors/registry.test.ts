import { describe, expect, test } from "bun:test";
import { connectorNames, hasConnector, loadConnector } from "../../src/connectors/registry.ts";

/** Every connector that must resolve from the registry, in sorted order. */
const EXPECTED = ["box", "github", "google", "ms-graph", "slack", "web"];

describe("connector registry", () => {
  test("connectorNames returns the full registered set, sorted", () => {
    expect(connectorNames()).toEqual(EXPECTED);
  });

  test("hasConnector reflects registration", () => {
    for (const name of EXPECTED) expect(hasConnector(name)).toBe(true);
    expect(hasConnector("does-not-exist")).toBe(false);
  });

  test("loadConnector builds each registered connector (import paths resolve)", async () => {
    // Building only constructs the connector (config parsed with defaults); the
    // heavy SDK is lazy-imported inside `sync`, so this stays import-clean. A
    // typo in any registry import path would surface here, not only at sync time.
    for (const name of EXPECTED) {
      const connector = await loadConnector(name, {});
      expect(typeof connector.name).toBe("string");
      expect(typeof connector.sourceType).toBe("string");
      expect(typeof connector.sync).toBe("function");
    }
  });

  test("loadConnector throws for an unknown connector", async () => {
    await expect(loadConnector("nope", {})).rejects.toThrow(/unknown connector/);
  });
});
