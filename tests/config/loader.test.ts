import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  Config,
  ConfigError,
  envToLayer,
  loadConfig,
  resolveConfigDir,
} from "../../src/config/index.ts";

describe("resolveConfigDir", () => {
  test("explicit dir wins over env", () => {
    expect(resolveConfigDir({ SUASOR_CONFIG_DIR: "/from/env" }, "/explicit")).toBe("/explicit");
  });

  test("SUASOR_CONFIG_DIR is used when no explicit dir", () => {
    expect(resolveConfigDir({ SUASOR_CONFIG_DIR: "/from/env" })).toBe("/from/env");
  });

  test("falls back to ~/.config/suasor", () => {
    expect(resolveConfigDir({ HOME: "/home/u" })).toBe("/home/u/.config/suasor");
  });
});

describe("envToLayer", () => {
  test("maps SUASOR_*__* into a nested layer", () => {
    const layer = envToLayer({ SUASOR_EMBEDDING__BACKEND: "ollama" });
    expect(layer).toEqual({ embedding: { backend: "ollama" } });
  });

  test("coerces boolean and numeric scalars", () => {
    const layer = envToLayer({
      SUASOR_A__FLAG: "true",
      SUASOR_A__COUNT: "42",
      SUASOR_A__NAME: "bge-m3",
    });
    expect(layer).toEqual({ a: { flag: true, count: 42, name: "bge-m3" } });
  });

  test("ignores non-SUASOR vars and SUASOR_CONFIG_DIR", () => {
    const layer = envToLayer({ PATH: "/usr/bin", SUASOR_CONFIG_DIR: "/x" });
    expect(layer).toEqual({});
  });
});

describe("loadConfig precedence (init args > env > file > defaults)", () => {
  test("defaults apply when nothing is set", async () => {
    const cfg = await loadConfig({ env: {}, configDir: "/cfg", fileLayer: {} });
    expect(cfg.embedding.backend).toBe("disabled");
    expect(cfg.llm.backend).toBe("disabled");
    // null dbPath resolves to <configDir>/suasor.db
    expect(cfg.storage.dbPath).toBe(join("/cfg", "suasor.db"));
    expect(cfg.connectors).toEqual({});
  });

  test("file overrides defaults", async () => {
    const cfg = await loadConfig({
      env: {},
      configDir: "/cfg",
      fileLayer: { embedding: { backend: "voyage" } },
    });
    expect(cfg.embedding.backend).toBe("voyage");
  });

  test("env overrides file", async () => {
    const cfg = await loadConfig({
      env: { SUASOR_EMBEDDING__BACKEND: "ollama" },
      configDir: "/cfg",
      fileLayer: { embedding: { backend: "voyage" } },
    });
    expect(cfg.embedding.backend).toBe("ollama");
  });

  test("init args override env and file", async () => {
    const cfg = await loadConfig({
      env: { SUASOR_EMBEDDING__BACKEND: "ollama" },
      configDir: "/cfg",
      fileLayer: { embedding: { backend: "voyage" } },
      initArgs: { embedding: { backend: "openai" } },
    });
    expect(cfg.embedding.backend).toBe("openai");
  });

  test("explicit dbPath overrides the resolved default", async () => {
    const cfg = await loadConfig({
      env: {},
      configDir: "/cfg",
      fileLayer: { storage: { dbPath: "/data/x.db" } },
    });
    expect(cfg.storage.dbPath).toBe("/data/x.db");
  });

  test("deep merge keeps untouched sibling fields", async () => {
    const cfg = await loadConfig({
      env: { SUASOR_LLM__BACKEND: "anthropic" },
      configDir: "/cfg",
      fileLayer: { embedding: { backend: "ollama" } },
    });
    expect(cfg.embedding.backend).toBe("ollama");
    expect(cfg.llm.backend).toBe("anthropic");
  });
});

describe("loadConfig fail-fast", () => {
  test("rejects an invalid enum value with ConfigError", async () => {
    const promise = loadConfig({
      env: {},
      configDir: "/cfg",
      fileLayer: { embedding: { backend: "torch-local" } },
    });
    await expect(promise).rejects.toBeInstanceOf(ConfigError);
  });

  test("ConfigError carries per-field issues", async () => {
    try {
      await loadConfig({
        env: { SUASOR_EMBEDDING__BACKEND: "nope" },
        configDir: "/cfg",
        fileLayer: {},
      });
      throw new Error("expected ConfigError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const err = e as ConfigError;
      expect(err.issues.some((i) => i.includes("embedding.backend"))).toBe(true);
    }
  });
});

describe("Config schema", () => {
  test("infers a stable shape via parse of defaults", () => {
    const cfg = Config.parse({});
    expect(cfg.storage.dbPath).toBeNull();
    expect(cfg.embedding.backend).toBe("disabled");
  });
});
