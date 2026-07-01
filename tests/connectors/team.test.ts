import { describe, expect, test } from "bun:test";
import { teamFromMeta } from "../../src/connectors/team.ts";

describe("teamFromMeta (ADR-0037 §10, Issue #361)", () => {
  test("extracts the team id + resolved name from slack meta", () => {
    expect(teamFromMeta("slack", { team: "T1", teamName: "Acme" })).toEqual({
      teamId: "T1",
      displayName: "Acme",
    });
  });

  test("a missing / blank teamName leaves displayName unset (degrade → id fallback)", () => {
    expect(teamFromMeta("slack", { team: "T1" })).toEqual({ teamId: "T1" });
    expect(teamFromMeta("slack", { team: "T1", teamName: "" })).toEqual({ teamId: "T1" });
    expect(teamFromMeta("slack", { team: "T1", teamName: "   " })).toEqual({ teamId: "T1" });
  });

  test("trims the id and name", () => {
    expect(teamFromMeta("slack", { team: "  T1  ", teamName: "  Acme  " })).toEqual({
      teamId: "T1",
      displayName: "Acme",
    });
  });

  test("returns null for a connector with no team mapping", () => {
    expect(teamFromMeta("github", { team: "T1" })).toBeNull();
  });

  test("returns null when the team id is missing / blank / non-string", () => {
    expect(teamFromMeta("slack", {})).toBeNull();
    expect(teamFromMeta("slack", { team: "" })).toBeNull();
    expect(teamFromMeta("slack", { team: "   " })).toBeNull();
    expect(teamFromMeta("slack", { team: 123 })).toBeNull();
  });
});
