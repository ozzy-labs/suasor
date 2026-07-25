/**
 * local ↔ API connector overlap detection (Issue #514).
 *
 * The point is a specific, silent failure: an OS-synced cloud mount read as
 * plain files *plus* that service's API connector ingests every shared file
 * twice under two ids. Nothing surfaced it, so the duplication was only ever
 * noticed as the same document appearing twice in a result list.
 *
 * These tests also pin the restraint: the detector is a heuristic over
 * conventional mount names, so it must stay quiet unless *both* halves of the
 * overlap are actually present.
 */
import { describe, expect, test } from "bun:test";
import { detectLocalOverlaps } from "../../src/connectors/local-overlap.ts";

describe("detectLocalOverlaps", () => {
  test("flags a Box mount when the box connector is enabled", () => {
    const [overlap] = detectLocalOverlaps(["/home/me/Box/Projects"], ["box", "github"]);
    expect(overlap?.connector).toBe("box");
    expect(overlap?.message).toContain("ingested twice");
    // The message must name both halves — the fix is a choice between them.
    expect(overlap?.message).toContain("/home/me/Box/Projects");
    expect(overlap?.message).toContain("box");
  });

  test("flags OneDrive for ms-graph and Drive for google", () => {
    expect(detectLocalOverlaps(["/Users/me/OneDrive - Acme"], ["ms-graph"])).toHaveLength(1);
    expect(detectLocalOverlaps(["/Users/me/Google Drive/My Drive"], ["google"])).toHaveLength(1);
  });

  test("recognises the macOS CloudStorage layout", () => {
    const roots = ["/Users/me/Library/CloudStorage/OneDrive-Personal/notes"];
    expect(detectLocalOverlaps(roots, ["ms-graph"])).toHaveLength(1);
  });

  test("stays quiet when the API connector is not enabled", () => {
    // Reading a synced folder is perfectly fine on its own — the duplication
    // only exists when both routes ingest the same files.
    expect(detectLocalOverlaps(["/home/me/Box/Projects"], ["github"])).toEqual([]);
  });

  test("stays quiet for an unrelated root even with the connector enabled", () => {
    expect(detectLocalOverlaps(["/home/me/notes"], ["box", "ms-graph", "google"])).toEqual([]);
  });

  test("does not match a folder that merely contains the word", () => {
    // "boxes" / "sandbox" must not trip the box pattern — a false positive
    // costs a confusing warning about a duplication that isn't happening.
    expect(detectLocalOverlaps(["/home/me/sandbox/notes"], ["box"])).toEqual([]);
    expect(detectLocalOverlaps(["/home/me/boxes"], ["box"])).toEqual([]);
  });

  test("is case-insensitive and tolerates trailing separators", () => {
    expect(detectLocalOverlaps(["/home/me/box/"], ["box"])).toHaveLength(1);
    expect(detectLocalOverlaps(["/home/me/BOX/docs"], ["box"])).toHaveLength(1);
  });

  test("reports one overlap per (root, connector) pair", () => {
    const overlaps = detectLocalOverlaps(
      ["/home/me/Box/a", "/home/me/OneDrive/b", "/home/me/plain"],
      ["box", "ms-graph"],
    );
    expect(overlaps.map((o) => o.connector).sort()).toEqual(["box", "ms-graph"]);
  });

  test("no roots and no connectors is a clean no-op", () => {
    expect(detectLocalOverlaps([], ["box"])).toEqual([]);
    expect(detectLocalOverlaps(["/home/me/Box"], [])).toEqual([]);
  });
});
