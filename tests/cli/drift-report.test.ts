/**
 * Drift report rendering (`<connector> <verb> --new`, ADR-0049).
 *
 * The renderer is pure, so the exact wording an operator acts on is pinned here
 * without a credential or a network round-trip. Two of these assertions are
 * behavioural, not cosmetic: the output must never imply it changed anything
 * (explicit enumeration is the model), and a narrowed run must say "not checked"
 * rather than print an empty removed section that reads as "none".
 */
import { describe, expect, test } from "bun:test";
import { renderDriftReport } from "../../src/cli/drift-report.ts";
import type { DiscoveryDiff, DiscoveryScope } from "../../src/connectors/discovery-specs.ts";

const SCOPE: DiscoveryScope = { key: "repos", idNote: "repos are 'owner/repo' full names" };

function report(diff: DiscoveryDiff) {
  const { out, err } = renderDriftReport({
    connector: "github",
    itemNoun: "repository",
    scope: SCOPE,
    diff,
  });
  return { out: out.join("\n"), err: err.join("\n") };
}

describe("renderDriftReport — new items", () => {
  const diff: DiscoveryDiff = {
    added: [{ value: "acme/widget", label: "private" }],
    removed: [],
    removedComputed: true,
  };

  test("lists the new ids and a paste-ready fragment under the real config key", () => {
    const { out } = report(diff);
    expect(out).toContain("1 new repository(s) visible but not in config");
    expect(out).toContain("acme/widget  (private)");
    expect(out).toContain("[connectors.github]");
    expect(out).toContain('"acme/widget",  # private');
    expect(out).toContain("repos = [");
  });

  test("the next-step says to MERGE, and states that nothing was ingested or written", () => {
    const { err } = report(diff);
    expect(err).toContain("merge the ids above");
    expect(err).toContain("nothing was ingested or written");
  });
});

describe("renderDriftReport — settled config", () => {
  test("says so plainly and emits no config fragment to paste", () => {
    const { out, err } = report({ added: [], removed: [], removedComputed: true });
    expect(out).toContain("no new repository(s)");
    expect(out).toContain("[connectors.github].repos");
    expect(out).not.toContain("repos = [");
    // Nothing to act on ⇒ no next-step line.
    expect(err).toBe("");
  });
});

describe("renderDriftReport — removed half", () => {
  test("names the configured ids that are no longer visible and what it means", () => {
    const { out } = report({
      added: [],
      removed: ["acme/gone", "acme/renamed"],
      removedComputed: true,
    });
    expect(out).toContain("2 configured repository(s) not visible");
    expect(out).toContain("they sync nothing");
    expect(out).toContain("acme/gone");
    expect(out).toContain("acme/renamed");
  });

  test("a narrowed view says 'not checked', never an empty section reading as 'none'", () => {
    const { out } = report({ added: [], removed: [], removedComputed: false });
    expect(out).toContain("removed: not checked");
    expect(out).toContain("--filter / --root");
    expect(out).not.toContain("not visible to this credential");
  });

  test("a settled unnarrowed run stays silent about removals", () => {
    const { out } = report({ added: [], removed: [], removedComputed: true });
    expect(out).not.toContain("not checked");
    expect(out).not.toContain("not visible to this credential");
  });
});
