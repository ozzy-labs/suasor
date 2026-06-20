/**
 * Secret masking for `config show` (NFR-PRV-4, src/config/mask.ts).
 */
import { describe, expect, test } from "bun:test";
import { isSecretKey, MASKED, maskSecrets } from "../../src/config/mask.ts";

describe("isSecretKey", () => {
  test("matches common secret-bearing key names (case-insensitive)", () => {
    for (const key of [
      "token",
      "accessToken",
      "refreshToken",
      "secret",
      "clientSecret",
      "password",
      "apiKey",
      "credential",
    ]) {
      expect(isSecretKey(key)).toBe(true);
    }
  });

  test("leaves ordinary config keys untouched", () => {
    for (const key of ["backend", "model", "baseUrl", "dim", "enabled", "repos", "dbPath"]) {
      expect(isSecretKey(key)).toBe(false);
    }
  });
});

describe("maskSecrets", () => {
  test("masks secret-keyed values at any depth and in arrays", () => {
    const input = {
      embedding: { backend: "ollama", model: "bge-m3" },
      connectors: {
        github: { repos: ["a", "b"], token: "ghp_xxx" },
        custom: { entries: [{ apiKey: "k1" }, { apiKey: "k2", label: "ok" }] },
      },
    };
    const out = maskSecrets(input);
    expect(out.connectors.github.token).toBe(MASKED);
    expect(out.connectors.github.repos).toEqual(["a", "b"]);
    expect(out.connectors.custom.entries[0]?.apiKey).toBe(MASKED);
    expect(out.connectors.custom.entries[1]?.apiKey).toBe(MASKED);
    expect(out.connectors.custom.entries[1]?.label).toBe("ok");
    expect(out.embedding).toEqual({ backend: "ollama", model: "bge-m3" });
  });

  test("does not mutate the input", () => {
    const input = { connectors: { github: { token: "ghp_xxx" } } };
    maskSecrets(input);
    expect(input.connectors.github.token).toBe("ghp_xxx");
  });
});
