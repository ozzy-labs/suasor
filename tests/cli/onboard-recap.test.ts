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

  test("an already-present slice → `config already present (left untouched)`", () => {
    const input = {
      connectors: [ok({ configSource: "skipped" })],
      synced: false,
      syncExitCode: null,
    };
    const text = renderRecap(input);
    expect(text).toContain("config already present (left untouched)");
    expect(recapHasFailure(input)).toBe(false);
  });
});

/**
 * Pre-sync config advisories (Issue #544). The first sync now emits them (an
 * empty ingest scope #187, an unset required setting ADR-0049 / ADR-0051) exactly
 * as `suasor sync` does; the recap's job is only to keep the closing verdict from
 * reading "Setup complete." over one — never to restate the advisory text, and
 * never to change the exit code.
 */
describe("renderRecap — pre-sync config warnings", () => {
  test("names the labels it was raised for and qualifies the closing verdict", () => {
    const input = {
      connectors: [ok({ connector: "ms-graph", configSource: "template" as const })],
      synced: true,
      syncExitCode: 0,
      configWarnings: ["ms-graph"],
    };
    const text = renderRecap(input);
    expect(text).toContain("config: 1 pre-sync warning(s) for ms-graph");
    expect(text).toContain("see the `warning:` line(s) on stderr");
    expect(text).toContain("Setup complete, but 1 pre-sync config warning(s) are unresolved.");
    // The advisory's own wording stays with its single emitter (the sync).
    expect(text).not.toContain("required setting");
    // A warning is not a failure: #187 / ADR-0049 both leave the exit code alone.
    expect(recapHasFailure(input)).toBe(false);
  });

  test("carries the account label so a per-account advisory is attributable", () => {
    const text = renderRecap({
      connectors: [ok({ connector: "google", account: "work" })],
      synced: true,
      syncExitCode: 0,
      configWarnings: ["google (account 'work')"],
    });
    expect(text).toContain("config: 1 pre-sync warning(s) for google (account 'work')");
  });

  test("a real failure still wins the verdict line", () => {
    const input = {
      connectors: [ok()],
      synced: true,
      syncExitCode: 1,
      configWarnings: ["github"],
    };
    const text = renderRecap(input);
    expect(text).toContain("config: 1 pre-sync warning(s) for github");
    expect(text).toContain("Setup finished with errors");
    expect(text).not.toContain("Setup complete");
    expect(recapHasFailure(input)).toBe(true);
  });

  test("no warnings → the block and the verdict are byte-for-byte the old ones", () => {
    const base = { connectors: [ok()], synced: true, syncExitCode: 0 };
    expect(renderRecap({ ...base, configWarnings: [] })).toBe(renderRecap(base));
    expect(renderRecap(base)).toContain("Setup complete.");
    expect(renderRecap(base)).not.toContain("pre-sync warning");
  });
});

/**
 * Vectors the first sync did not write (Issue #547). The gap outlives the run —
 * a later `suasor sync` only embeds new or changed sources — so the recap states
 * it and names `suasor embeddings drain`, the command that closes it. It is not
 * a failure: `suasor sync` exits 0 on both a disabled backend and a best-effort
 * embed miss, and the wizard must not invent a failure the sync does not have.
 */
describe("renderRecap — embeddings the first sync did not write", () => {
  const base = { connectors: [ok()], synced: true, syncExitCode: 0 };

  test("a disabled backend → the count, the permanence, and the drain command", () => {
    const input = {
      ...base,
      embeddings: { ingested: 12, embedded: 0, backendDisabled: true },
    };
    const text = renderRecap(input);
    expect(text).toContain("embeddings: [embedding].backend is disabled");
    expect(text).toContain("12 source(s) this sync ingested have no vectors");
    expect(text).toContain("A later sync only embeds new or changed sources");
    expect(text).toContain("suasor embeddings drain");
    expect(text).toContain("guide/embedding.md");
    // The default install is FTS-first (ADR-0005), so this is a statement about
    // the corpus — not a broken setup, and not an exit-worthy one.
    expect(text).toContain("Setup complete.");
    expect(recapHasFailure(input)).toBe(false);
  });

  test("a partly-embedded run → the remainder, not the disabled-backend sentence", () => {
    const input = {
      ...base,
      embeddings: { ingested: 12, embedded: 5, backendDisabled: false },
    };
    const text = renderRecap(input);
    expect(text).toContain("embeddings: 5 of 12 ingested source(s) embedded");
    expect(text).toContain("the other 7 have no vector");
    expect(text).toContain("suasor embeddings drain");
    // A sidecar that did not answer is a different claim from a backend nobody
    // configured, so the two never share a sentence.
    expect(text).not.toContain("is disabled");
    expect(recapHasFailure(input)).toBe(false);
  });

  test("everything embedded (field absent) → byte-for-byte the old block", () => {
    expect(renderRecap(base)).not.toContain("embeddings:");
    expect(renderRecap(base)).toContain("Setup complete.");
  });

  test("a real failure still wins the verdict line", () => {
    const input = {
      ...base,
      syncExitCode: 1,
      embeddings: { ingested: 3, embedded: 0, backendDisabled: true },
    };
    const text = renderRecap(input);
    expect(text).toContain("embeddings: [embedding].backend is disabled");
    expect(text).toContain("Setup finished with errors");
    expect(recapHasFailure(input)).toBe(true);
  });
});

/**
 * Account mode (ADR-0050 / Issue #538): the recap has to name the account, and
 * every recovery command it prints has to carry `--account` — without it the
 * command either refuses as ambiguous or verifies the wrong account.
 */
describe("renderRecap — --account runs", () => {
  test("labels the connector with its account", () => {
    const input = {
      connectors: [ok({ connector: "google", account: "work" })],
      synced: false,
      syncExitCode: null,
    };
    expect(renderRecap(input)).toContain("google (account 'work'): auth ok");
  });

  test("the auth-test recovery command targets the account", () => {
    const input = {
      connectors: [ok({ connector: "google", account: "work", authTest: "failed" })],
      synced: false,
      syncExitCode: null,
    };
    expect(renderRecap(input)).toContain("suasor google auth test --account work");
  });

  test("the discovery re-run command carries --account (it is refused without one)", () => {
    const input = {
      connectors: [
        ok({
          connector: "box",
          account: "work",
          configSource: "template",
          discoverySkippedVerb: "folders",
        }),
      ],
      synced: false,
      syncExitCode: null,
    };
    expect(renderRecap(input)).toContain("suasor box folders --account work");
  });

  test("the placeholder clause points at the account's own table", () => {
    const input = {
      connectors: [ok({ connector: "box", account: "work", configSource: "template" })],
      synced: false,
      syncExitCode: null,
    };
    expect(renderRecap(input)).toContain("edit [connectors.box.accounts.work] in config.toml");
  });

  test("a flat run is unchanged (no account clause anywhere)", () => {
    const text = renderRecap({
      connectors: [ok({ authTest: "failed" })],
      synced: false,
      syncExitCode: null,
    });
    expect(text).toContain("suasor github auth test`");
    expect(text).not.toContain("--account");
    expect(text).not.toContain("(account");
  });
});
