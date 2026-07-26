/**
 * Generic discovery drift (ADR-0049 — ADR-0039 Layer 1 generalized onto the
 * DISCOVERY_SPECS registry, Issue #478).
 *
 * The diff is pure, so it is pinned here directly: which ids count as new, when
 * `removed` may be claimed at all (never on a narrowed view), and the per-spec
 * declaration that every discovery connector either has a diffable scope or says
 * why it does not — the "silently missing capability" ADR-0030's Alternatives
 * rejected per-connector paths to avoid.
 */
import { describe, expect, test } from "bun:test";
import {
  configuredIds,
  DISCOVERY_SPECS,
  type DiscoveryItem,
  type DiscoveryScope,
  diffDiscovered,
  discoveryConnectorNames,
} from "../../src/connectors/discovery-specs.ts";

const SCOPE: DiscoveryScope = { key: "repos", idNote: "note" };

function items(...values: string[]): DiscoveryItem[] {
  return values.map((value) => ({ value, label: "label" }));
}

describe("diffDiscovered — visible vs configured", () => {
  test("visible but not configured is new", () => {
    const diff = diffDiscovered(items("a/one", "a/two"), ["a/one"], SCOPE);
    expect(diff.added.map((i) => i.value)).toEqual(["a/two"]);
  });

  test("configured but not visible is removed", () => {
    const diff = diffDiscovered(items("a/one"), ["a/one", "a/gone"], SCOPE);
    expect(diff.removed).toEqual(["a/gone"]);
    expect(diff.removedComputed).toBe(true);
  });

  test("a settled config yields nothing in either direction", () => {
    const diff = diffDiscovered(items("a/one"), ["a/one"], SCOPE);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  test("comparison is case-insensitive and trims (github casing is not drift)", () => {
    const diff = diffDiscovered(items("Acme/Repo"), ["  acme/repo "], SCOPE);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  test("a narrowed view never claims removed", () => {
    const diff = diffDiscovered(items("a/one"), ["a/one", "a/elsewhere"], SCOPE, true);
    expect(diff.removedComputed).toBe(false);
    expect(diff.removed).toEqual([]);
    // …but `new` is still meaningful within the narrowed view.
    expect(diff.added).toEqual([]);
  });

  test("an empty config makes everything visible new (first-run shape)", () => {
    const diff = diffDiscovered(items("a/one", "a/two"), [], SCOPE);
    expect(diff.added).toHaveLength(2);
    expect(diff.removed).toEqual([]);
  });

  test("a per-spec normalizer is honoured on both sides", () => {
    const notion = DISCOVERY_SPECS.notion?.scope;
    expect(notion).toBeDefined();
    const dashed = "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d";
    const compact = dashed.replaceAll("-", "");
    const diff = diffDiscovered(items(dashed), [compact], notion as DiscoveryScope);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });
});

describe("configuredIds — lenient slice read", () => {
  test("reads the declared key", () => {
    expect(configuredIds({ repos: ["a/one"] }, SCOPE)).toEqual(["a/one"]);
  });

  test("an absent or non-array key reads as empty rather than throwing", () => {
    expect(configuredIds({}, SCOPE)).toEqual([]);
    expect(configuredIds({ repos: "a/one" }, SCOPE)).toEqual([]);
  });

  test("non-string entries are dropped", () => {
    expect(configuredIds({ repos: ["a/one", 42] }, SCOPE)).toEqual(["a/one"]);
  });
});

describe("DISCOVERY_SPECS — drift capability is declared, never silently absent", () => {
  for (const name of discoveryConnectorNames()) {
    test(`${name}: has a diffable scope or a documented reason it has none`, () => {
      const spec = DISCOVERY_SPECS[name];
      expect(spec).toBeDefined();
      if (spec?.scope) {
        expect(spec.scope.key.length).toBeGreaterThan(0);
        expect(spec.scope.idNote.length).toBeGreaterThan(0);
      } else {
        expect(spec?.driftNote?.length ?? 0).toBeGreaterThan(0);
      }
    });
  }

  test("google opts out because its scope is a single calendarId", () => {
    expect(DISCOVERY_SPECS.google?.scope).toBeUndefined();
    expect(DISCOVERY_SPECS.google?.driftNote).toContain("calendarId");
  });

  test("the set-scoped connectors point at their real config key", () => {
    expect(DISCOVERY_SPECS.github?.scope?.key).toBe("repos");
    expect(DISCOVERY_SPECS.notion?.scope?.key).toBe("databases");
    expect(DISCOVERY_SPECS.jira?.scope?.key).toBe("projects");
    expect(DISCOVERY_SPECS.box?.scope?.key).toBe("folders");
  });
});
