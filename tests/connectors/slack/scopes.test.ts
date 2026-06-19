import { describe, expect, test } from "bun:test";
import {
  assessReadiness,
  FEATURE_SCOPES,
  historyScopeForType,
  renderFeaturesBlock,
} from "../../../src/connectors/slack/scopes.ts";

const ALL_SCOPES = "channels:history,groups:history,im:history,mpim:history,search:read,users:read";

describe("scopes — historyScopeForType", () => {
  test("maps each conversation type to its *:history scope", () => {
    expect(historyScopeForType("public")).toBe("channels:history");
    expect(historyScopeForType("private")).toBe("groups:history");
    expect(historyScopeForType("im")).toBe("im:history");
    expect(historyScopeForType("mpim")).toBe("mpim:history");
  });

  test("throws on an unknown type", () => {
    expect(() => historyScopeForType("bogus")).toThrow(/unknown conversation type/);
  });
});

describe("scopes — assessReadiness", () => {
  test("a user token with every scope reads all features READY", () => {
    const results = assessReadiness(ALL_SCOPES, "user");
    expect(results.map((r) => r.status)).toEqual(["READY", "READY", "READY", "READY", "READY"]);
    expect(results.every((r) => r.ready)).toBe(true);
  });

  test("channels-only token: public degraded (no users:read), the rest MISSING", () => {
    const byFeature = Object.fromEntries(
      assessReadiness("channels:history", "user").map((r) => [r.feature, r]),
    );
    expect(byFeature.sync_public?.ready).toBe(true);
    expect(byFeature.sync_public?.status).toMatch(/READY \(degraded: \+users:read/);
    expect(byFeature.sync_private?.status).toBe("MISSING groups:history");
    expect(byFeature.sync_private?.missing).toEqual(["groups:history"]);
    expect(byFeature.sync_dm?.status).toBe("MISSING im:history");
  });

  test("a Bot principal sees the engagement axis as N/A, never MISSING", () => {
    const engagement = assessReadiness("channels:history,users:read", "bot").find(
      (r) => r.feature === "engagement_axis",
    );
    expect(engagement?.status).toBe("N/A (User Token only)");
    expect(engagement?.ready).toBe(false);
    expect(engagement?.missing).toEqual([]);
  });

  test("a User principal without search:read sees engagement MISSING", () => {
    const engagement = assessReadiness("channels:history", "user").find(
      (r) => r.feature === "engagement_axis",
    );
    expect(engagement?.status).toBe("MISSING search:read");
  });

  test("every feature is labelled and ordered per FEATURE_SCOPES", () => {
    const results = assessReadiness(ALL_SCOPES, "user");
    expect(results.map((r) => r.feature as string)).toEqual(Object.keys(FEATURE_SCOPES));
    expect(results.every((r) => r.label.length > 0)).toBe(true);
  });
});

describe("scopes — renderFeaturesBlock", () => {
  test("renders one line per feature plus the membership footnote", () => {
    const lines = renderFeaturesBlock(ALL_SCOPES, "user");
    expect(lines).toHaveLength(Object.keys(FEATURE_SCOPES).length + 1);
    expect(lines.at(-1)).toMatch(/does not guarantee channel membership/);
    expect(lines.at(-1)).toMatch(/not_in_channel/);
  });

  test("degrades to a single line when the scopes header is unavailable", () => {
    const lines = renderFeaturesBlock("", "user");
    expect(lines).toEqual(["  (scopes header unavailable — cannot assess readiness)"]);
  });
});
