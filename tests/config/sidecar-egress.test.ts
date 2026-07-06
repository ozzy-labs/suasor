/**
 * Sidecar-egress loopback detection + active-endpoint collection (Issue #436,
 * boundary/export-1). The loopback gate is the substrate for the loader's
 * fail-fast rejection and `collectConfigWarnings`' disclosure; these assert the
 * pure detection logic and which sidecars count as content-egressing.
 */
import { describe, expect, test } from "bun:test";
import {
  collectSidecarEndpoints,
  isLoopbackUrl,
  type SidecarEgressInput,
} from "../../src/config/index.ts";

describe("isLoopbackUrl", () => {
  test("accepts localhost / 127.0.0.0-8 / ::1", () => {
    for (const url of [
      "http://localhost:11434",
      "http://localhost/compose",
      "http://127.0.0.1:8929",
      "http://127.0.0.5:8930", // rest of the 127.0.0.0/8 block
      "http://[::1]:8930",
      "https://LOCALHOST:443", // case-insensitive
    ]) {
      expect(isLoopbackUrl(url)).toBe(true);
    }
  });

  test("rejects non-loopback hosts", () => {
    for (const url of [
      "http://sidecar:11434",
      "https://api.openai.com",
      "http://10.0.0.5:8929",
      "http://192.168.1.10:8930",
      "http://compose.internal.example.com/compose",
      "http://0.0.0.0:8930", // all-interfaces bind is not loopback
    ]) {
      expect(isLoopbackUrl(url)).toBe(false);
    }
  });

  test("an unparseable URL is treated as non-loopback (fail-safe → gated)", () => {
    expect(isLoopbackUrl("not a url")).toBe(false);
    expect(isLoopbackUrl("")).toBe(false);
  });
});

/** Minimal structural input with all sidecars off by default. */
function input(overrides: Partial<SidecarEgressInput> = {}): SidecarEgressInput {
  return {
    embedding: { backend: "disabled" },
    ...overrides,
  };
}

describe("collectSidecarEndpoints", () => {
  test("nothing active → no endpoints", () => {
    expect(collectSidecarEndpoints(input())).toEqual([]);
    expect(
      collectSidecarEndpoints(
        input({
          extraction: { backend: "disabled", baseUrl: "http://sidecar:8929" },
          export: { composition: { backend: "disabled", baseUrl: "http://sidecar:8930" } },
        }),
      ),
    ).toEqual([]);
  });

  test("markitdown extraction is an active endpoint with its loopback flag", () => {
    const [local] = collectSidecarEndpoints(
      input({ extraction: { backend: "markitdown", baseUrl: "http://localhost:8929" } }),
    );
    expect(local).toMatchObject({
      section: "extraction",
      allowRemoteKey: "extraction.allowRemote",
      loopback: true,
      allowRemote: false,
    });

    const [remote] = collectSidecarEndpoints(
      input({
        extraction: { backend: "markitdown", baseUrl: "http://sidecar:8929", allowRemote: true },
      }),
    );
    expect(remote).toMatchObject({ section: "extraction", loopback: false, allowRemote: true });
  });

  test("pandoc export.composition is an active endpoint", () => {
    const [ep] = collectSidecarEndpoints(
      input({ export: { composition: { backend: "pandoc", baseUrl: "http://sidecar:8930" } } }),
    );
    expect(ep).toMatchObject({
      section: "export.composition",
      allowRemoteKey: "export.composition.allowRemote",
      loopback: false,
    });
  });

  test("ollama embedding is an active endpoint (loopback-gated local sidecar)", () => {
    const [ep] = collectSidecarEndpoints(
      input({ embedding: { backend: "ollama", baseUrl: "http://sidecar:11434" } }),
    );
    expect(ep).toMatchObject({ section: "embedding", loopback: false });
  });

  test("openai/voyage embedding is NOT loopback-gated (remote-by-design, key-gated)", () => {
    for (const backend of ["openai", "voyage"] as const) {
      expect(
        collectSidecarEndpoints(
          input({ embedding: { backend, baseUrl: "https://api.openai.com" } }),
        ),
      ).toEqual([]);
    }
  });

  test("returns endpoints in config order (embedding, extraction, export.composition)", () => {
    const eps = collectSidecarEndpoints({
      embedding: { backend: "ollama", baseUrl: "http://sidecar:11434" },
      extraction: { backend: "markitdown", baseUrl: "http://sidecar:8929" },
      export: { composition: { backend: "pandoc", baseUrl: "http://sidecar:8930" } },
    });
    expect(eps.map((e) => e.section)).toEqual(["embedding", "extraction", "export.composition"]);
  });
});
