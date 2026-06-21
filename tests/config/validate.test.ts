/**
 * Config validation + safe-fix service (Issue #280). Unit-level: feeds raw
 * config trees with an injectable path-existence probe so dangling-reference
 * checks are deterministic, and asserts the classification + in-tree --fix.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "../../src/config/validate.ts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "suasor-validate-svc-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** A path probe that reports the given set of paths (and their ancestors) present. */
function probe(present: string[]): (p: string) => boolean {
  const set = new Set(present);
  return (p) => set.has(p);
}

describe("validateConfig", () => {
  test("a clean config yields no findings", async () => {
    const raw = {
      embedding: { backend: "disabled" },
      connectors: { github: { repos: ["owner/repo"] } },
    };
    const { findings } = await validateConfig(raw, false, () => true);
    expect(findings).toEqual([]);
  });

  test("classifies a bad enum as invalid-value (not fixable)", async () => {
    const { findings } = await validateConfig({ embedding: { backend: "x" } }, false, () => true);
    const f = findings.find((x) => x.path === "embedding.backend");
    expect(f?.kind).toBe("invalid-value");
    expect(f?.fixable).toBe(false);
  });

  test("classifies a regex violation as invalid-value", async () => {
    const { findings } = await validateConfig(
      { connectors: { github: { repos: ["nope"] } } },
      false,
      () => true,
    );
    const f = findings.find((x) => x.path.startsWith("connectors.github.repos"));
    expect(f?.kind).toBe("invalid-value");
  });

  test("classifies an unknown key as unknown-key (fixable)", async () => {
    const { findings } = await validateConfig(
      { connectors: { github: { repo: ["a/b"] } } },
      false,
      () => true,
    );
    const f = findings.find((x) => x.path === "connectors.github.repo");
    expect(f?.kind).toBe("unknown-key");
    expect(f?.fixable).toBe(true);
  });

  test("classifies a missing dbPath parent dir as dangling-reference", async () => {
    const { findings } = await validateConfig(
      { storage: { dbPath: "/nowhere/sub/suasor.db" } },
      false,
      probe([]), // nothing exists
    );
    const f = findings.find((x) => x.path === "storage.dbPath");
    expect(f?.kind).toBe("dangling-reference");
    expect(f?.fixable).toBe(false); // dbPath is never auto-dropped
  });

  test("classifies a missing local root as a fixable dangling-reference", async () => {
    const { findings } = await validateConfig(
      { connectors: { local: { roots: ["/missing"] } } },
      false,
      probe([]),
    );
    const f = findings.find((x) => x.path === "connectors.local.roots.0");
    expect(f?.kind).toBe("dangling-reference");
    expect(f?.fixable).toBe(true);
  });

  test("--fix drops typo keys and dangling roots without index drift", async () => {
    // local roots existence is checked by the connector schema against the real
    // FS (not the injected probe), so use a genuinely-existing dir for the keeper.
    const keep = join(tmp, "keep");
    mkdirSync(keep);
    const raw = {
      connectors: {
        github: { repo: ["a/b"], repos: ["owner/repo"] },
        local: { roots: [join(tmp, "missing-1"), keep, join(tmp, "missing-2")] },
      },
    };
    const { applied, fixed } = await validateConfig(raw, true);
    expect(applied).toContain("connectors.github.repo");
    expect(applied).toContain("connectors.local.roots.0");
    expect(applied).toContain("connectors.local.roots.2");
    const fc = fixed.connectors as {
      github?: Record<string, unknown>;
      local?: { roots?: unknown };
    };
    expect(fc.github).toEqual({ repos: ["owner/repo"] });
    expect(fc.local?.roots).toEqual([keep]);
  });

  test("--fix never invents a value for invalid-value findings", async () => {
    const raw = { embedding: { backend: "bogus" } };
    const { applied, findings } = await validateConfig(raw, true, () => true);
    expect(applied).toEqual([]);
    expect(findings.some((f) => f.kind === "invalid-value")).toBe(true);
  });

  test("leaves schema-less / unknown connectors lenient", async () => {
    const { findings } = await validateConfig(
      { connectors: { "made-up": { anything: 1 } } },
      false,
      () => true,
    );
    expect(findings).toEqual([]);
  });
});
