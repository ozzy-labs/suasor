/**
 * Per-connector config-slice validation at load time (Issue #162, ADR-0007).
 *
 * `loadConfig` re-validates each `[connectors.<name>]` slice against the
 * connector's own `*ConnectorConfig` schema **strictly**, so typos (e.g. `repo`
 * for `repos`) and type mismatches fail fast as `ConfigError` instead of silently
 * no-op'ing at sync time. Connectors without a slice schema, and config keys for
 * unregistered connectors, stay lenient (backward compatible).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig } from "../../src/config/index.ts";

/** Load a config with only a `[connectors]` layer (no disk / env). */
function loadWithConnectors(connectors: Record<string, unknown>) {
  return loadConfig({ env: {}, configDir: "/cfg", fileLayer: { connectors } });
}

/**
 * A real, readable directory the `local` connector's load-time root validation
 * (Issue #188) can pass. `local`'s slice schema verifies each `roots` entry
 * exists and is a readable directory at load time, so valid-slice tests must
 * point at a path that actually exists on disk.
 */
let realRoot: string;
beforeAll(() => {
  realRoot = mkdtempSync(join(tmpdir(), "suasor-cfg-slice-"));
});
afterAll(() => {
  rmSync(realRoot, { recursive: true, force: true });
});

describe("loadConfig — connector slice validation (valid slices pass)", () => {
  test("github: a correct slice loads unchanged", async () => {
    const cfg = await loadWithConnectors({ github: { repos: ["owner/repo"], state: "open" } });
    expect(cfg.connectors.github).toEqual({ repos: ["owner/repo"], state: "open" });
  });

  test("slack: the flat (default workspace) shape passes", async () => {
    const cfg = await loadWithConnectors({ slack: { team: "T1", channels: ["C1"] } });
    expect(cfg.connectors.slack).toEqual({ team: "T1", channels: ["C1"] });
  });

  test("slack: the multi-workspace shape passes", async () => {
    const cfg = await loadWithConnectors({
      slack: { workspaces: { acme: { team: "T2", channels: ["C2"] } } },
    });
    expect(cfg.connectors.slack).toEqual({
      workspaces: { acme: { team: "T2", channels: ["C2"] } },
    });
  });

  test("local: a correct roots/extensions slice (existing root) passes", async () => {
    const cfg = await loadWithConnectors({ local: { roots: [realRoot], maxBytes: 2048 } });
    expect(cfg.connectors.local).toEqual({ roots: [realRoot], maxBytes: 2048 });
  });

  test("jira: a correct slice loads unchanged", async () => {
    const cfg = await loadWithConnectors({
      jira: { host: "example.atlassian.net", email: "me@example.com", projects: ["PROJ"] },
    });
    expect(cfg.connectors.jira).toEqual({
      host: "example.atlassian.net",
      email: "me@example.com",
      projects: ["PROJ"],
    });
  });

  test("jira: a typo'd key (`project` for `projects`) rejects with ConfigError", async () => {
    await expect(
      loadWithConnectors({ jira: { host: "h", project: ["PROJ"] } }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  test("an empty slice (all defaults) passes for every connector", async () => {
    const cfg = await loadWithConnectors({
      github: {},
      slack: {},
      "ms-graph": {},
      google: {},
      box: {},
      notion: {},
      jira: {},
      web: {},
      local: {},
    });
    expect(cfg.connectors.github).toEqual({});
  });

  test("no connectors section stays empty", async () => {
    const cfg = await loadConfig({ env: {}, configDir: "/cfg", fileLayer: {} });
    expect(cfg.connectors).toEqual({});
  });
});

describe("loadConfig — connector slice validation (typos fail fast)", () => {
  test("github: a typo'd key (`repo` for `repos`) rejects with ConfigError", async () => {
    const promise = loadWithConnectors({ github: { repo: ["owner/repo"] } });
    await expect(promise).rejects.toBeInstanceOf(ConfigError);
  });

  test("github typo issue path is prefixed connectors.github", async () => {
    try {
      await loadWithConnectors({ github: { repo: ["owner/repo"] } });
      throw new Error("expected ConfigError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const err = e as ConfigError;
      expect(err.issues.some((i) => i.startsWith("connectors.github"))).toBe(true);
      expect(err.issues.some((i) => i.toLowerCase().includes("repo"))).toBe(true);
    }
  });

  test("slack: a typo'd key (`channel` for `channels`) rejects", async () => {
    await expect(loadWithConnectors({ slack: { channel: ["C1"] } })).rejects.toBeInstanceOf(
      ConfigError,
    );
  });

  test("local: a typo'd key (`root` for `roots`) rejects", async () => {
    await expect(loadWithConnectors({ local: { root: ["/data"] } })).rejects.toBeInstanceOf(
      ConfigError,
    );
  });
});

describe("loadConfig — connector slice validation (type mismatches fail fast)", () => {
  test("github: a non-array repos rejects with a field-pointed issue", async () => {
    try {
      await loadWithConnectors({ github: { repos: "owner/repo" } });
      throw new Error("expected ConfigError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const err = e as ConfigError;
      expect(err.issues.some((i) => i.startsWith("connectors.github.repos"))).toBe(true);
    }
  });

  test("github: an invalid enum (state) rejects", async () => {
    await expect(loadWithConnectors({ github: { state: "halfway" } })).rejects.toBeInstanceOf(
      ConfigError,
    );
  });

  test("github: a malformed `owner/repo` entry rejects", async () => {
    await expect(loadWithConnectors({ github: { repos: ["no-slash"] } })).rejects.toBeInstanceOf(
      ConfigError,
    );
  });

  test("web: a non-URL entry rejects", async () => {
    await expect(loadWithConnectors({ web: { urls: ["not a url"] } })).rejects.toBeInstanceOf(
      ConfigError,
    );
  });
});

describe("loadConfig — local roots path validation (Issue #188)", () => {
  test("a non-existent root rejects with a roots-pointed ConfigError", async () => {
    const missing = join(realRoot, "does-not-exist-typo");
    try {
      await loadWithConnectors({ local: { roots: [missing] } });
      throw new Error("expected ConfigError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const err = e as ConfigError;
      expect(err.issues.some((i) => i.startsWith("connectors.local.roots"))).toBe(true);
      expect(err.issues.some((i) => i.includes(missing))).toBe(true);
    }
  });

  test("a root that is a file (not a directory) rejects", async () => {
    const filePath = join(realRoot, "a-file.txt");
    writeFileSync(filePath, "x");
    await expect(loadWithConnectors({ local: { roots: [filePath] } })).rejects.toBeInstanceOf(
      ConfigError,
    );
  });

  test("an existing readable directory root passes", async () => {
    const cfg = await loadWithConnectors({ local: { roots: [realRoot] } });
    expect(cfg.connectors.local).toEqual({ roots: [realRoot] });
  });

  test("empty roots (no targets) passes — nothing to validate", async () => {
    const cfg = await loadWithConnectors({ local: { roots: [] } });
    expect(cfg.connectors.local).toEqual({ roots: [] });
  });

  test("the offending root index is pinpointed when only one of several is bad", async () => {
    const missing = join(realRoot, "nope");
    try {
      await loadWithConnectors({ local: { roots: [realRoot, missing] } });
      throw new Error("expected ConfigError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const err = e as ConfigError;
      // index 1 is the bad one; the issue path points at roots.1.
      expect(err.issues.some((i) => i.startsWith("connectors.local.roots.1"))).toBe(true);
    }
  });
});

describe("loadConfig — connector slice validation (lenient by omission)", () => {
  test("a config key for an unregistered connector stays untouched", async () => {
    const cfg = await loadWithConnectors({ "not-a-connector": { whatever: 123, typo: true } });
    expect(cfg.connectors["not-a-connector"]).toEqual({ whatever: 123, typo: true });
  });

  test("known and unknown connector slices coexist (known validated, unknown lenient)", async () => {
    const cfg = await loadWithConnectors({
      github: { repos: ["owner/repo"] },
      "future-connector": { anything: "goes" },
    });
    expect(cfg.connectors.github).toEqual({ repos: ["owner/repo"] });
    expect(cfg.connectors["future-connector"]).toEqual({ anything: "goes" });
  });

  test("aggregates issues across multiple offending connectors", async () => {
    try {
      await loadWithConnectors({ github: { repo: ["a/b"] }, slack: { channel: ["C1"] } });
      throw new Error("expected ConfigError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const err = e as ConfigError;
      expect(err.issues.some((i) => i.startsWith("connectors.github"))).toBe(true);
      expect(err.issues.some((i) => i.startsWith("connectors.slack"))).toBe(true);
    }
  });
});
