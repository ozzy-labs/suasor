import { describe, expect, test } from "bun:test";
import {
  connectorNames,
  hasConnector,
  hasConnectorConfigSchema,
  loadConnector,
  loadConnectorConfigSchema,
} from "../../src/connectors/registry.ts";

/** Every connector that must resolve from the registry, in sorted order. */
const EXPECTED = ["box", "github", "google", "jira", "local", "ms-graph", "notion", "slack", "web"];

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

  test("every registered connector exposes a config-slice schema (Issue #162)", () => {
    for (const name of EXPECTED) expect(hasConnectorConfigSchema(name)).toBe(true);
    expect(hasConnectorConfigSchema("does-not-exist")).toBe(false);
  });

  test("loadConnectorConfigSchema returns a parseable Zod schema for each connector", async () => {
    for (const name of EXPECTED) {
      const schema = await loadConnectorConfigSchema(name);
      expect(schema).not.toBeNull();
      // The schema parses its own defaults (empty slice) without throwing.
      expect(() => schema?.parse({})).not.toThrow();
    }
  });

  test("loadConnectorConfigSchema returns null for a schema-less / unknown connector", async () => {
    expect(await loadConnectorConfigSchema("does-not-exist")).toBeNull();
  });
});
