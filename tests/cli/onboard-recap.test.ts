/**
 * Pure recap builder for `suasor onboard` step 9 (Issue #388 item 1). No I/O:
 * every branch is exercised by feeding a `RecapInput` and asserting the rendered
 * lines + the {@link recapHasFailure} exit-code decision.
 */
import { describe, expect, test } from "bun:test";
import { type RecapConnector, recapHasFailure, renderRecap } from "../../src/cli/onboard/recap.ts";

/** A generic connector that authed + configured cleanly, with overrides. */
function ok(overrides: Partial<RecapConnector> = {}): RecapConnector {
  return {
    connector: "github",
    authFlow: "generic",
    authTest: "ok",
    configSource: "discovery",
    discovered: 2,
    ...overrides,
  };
}

describe("renderRecap", () => {
  test("all success → ok lines + `Setup complete.` (no failure)", () => {
    const input = { connectors: [ok()], synced: true, syncExitCode: 0 };
    const text = renderRecap(input);
    expect(text).toContain("Setup recap:");
    expect(text).toContain("github: auth ok; config appended (2 discovered).");
    expect(text).toContain("sync: ok");
    expect(text).toContain("Setup complete.");
    expect(text).not.toContain("FAILED");
    expect(recapHasFailure(input)).toBe(false);
  });

  test("an auth-test failure → FAILED line + recovery command + exit-worthy", () => {
    const input = {
      connectors: [ok({ authTest: "failed", configSource: "template" })],
      synced: false,
      syncExitCode: null,
    };
    const text = renderRecap(input);
    expect(text).toContain("auth test FAILED");
    expect(text).toContain("suasor github auth test");
    expect(text).toContain("Setup finished with errors");
    expect(recapHasFailure(input)).toBe(true);
  });

  test("a failed first sync → sync FAILED line + exit-worthy", () => {
    const input = { connectors: [ok()], synced: true, syncExitCode: 1 };
    const text = renderRecap(input);
    expect(text).toContain("sync: FAILED");
    expect(text).toContain("suasor sync");
    expect(text).toContain("Setup finished with errors");
    expect(recapHasFailure(input)).toBe(true);
  });

  test("a connector-specific skip (slack) → manual-steps note, not complete, exit 0", () => {
    const input = {
      connectors: [
        {
          connector: "slack",
          authFlow: "connector-specific",
          authTest: "skipped",
          configSource: "template",
        } satisfies RecapConnector,
      ],
      synced: false,
      syncExitCode: null,
    };
    const text = renderRecap(input);
    expect(text).toContain("finish the connector-specific steps above");
    expect(text).toContain("Setup needs manual steps");
    expect(recapHasFailure(input)).toBe(false);
  });

  test("a discovery-skipped connector → placeholder line points at the re-run verb", () => {
    const input = {
      connectors: [ok({ configSource: "template", discoverySkippedVerb: "repos" })],
      synced: false,
      syncExitCode: null,
    };
    const text = renderRecap(input);
    expect(text).toContain("config placeholder written — discovery skipped");
    expect(text).toContain("suasor github repos");
  });

  test("a --skip-auth connector → `auth skipped`, no failure", () => {
    const input = {
      connectors: [ok({ authTest: "skipped", configSource: "template" })],
      synced: false,
      syncExitCode: null,
    };
    const text = renderRecap(input);
    expect(text).toContain("auth skipped");
    expect(text).toContain("Setup complete.");
    expect(recapHasFailure(input)).toBe(false);
  });
});
