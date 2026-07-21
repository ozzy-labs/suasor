/**
 * Connector-specific onboarding bridges (#458): the CLI-side behaviour registry
 * behind the manifest's `connectorSpecificOnboard` declaration (#440
 * owned-vs-declared split — the manifest *declares* the capability; the bridge
 * lives in the CLI layer, since it drives stdin prompts, the keychain, and
 * config.toml edits that connectors must not depend on).
 *
 * The completeness test (`tests/connectors/manifest.test.ts`) cross-checks that
 * `connectorSpecificOnboard` and this registry can never drift: a manifest
 * declaring the capability must have a bridge here, and vice versa.
 *
 * Import-clean (NFR-PRF-1): bridge modules are lazy-imported on lookup, so
 * registering a bridge adds nothing to onboard's cold start.
 */
import type { KeychainBackend } from "../../connectors/secrets.ts";

/** Minimal writable surface (stdout / stderr) a bridge renders to. */
export interface BridgeWritable {
  write(chunk: string): unknown;
}

/** The per-connector report fields a bridge fills in (mirrors onboard's report). */
export interface BridgeReport {
  authStored: boolean;
  authTest: "ok" | "failed" | "skipped";
  authTestDetail?: string;
  configAppended: boolean;
  configSource: "discovery" | "template" | "skipped";
  discovered?: number;
}

/** Everything the wizard hands a bridge (no `this` — bridges are functions). */
export interface OnboardBridgeDeps {
  /** Raw stdin (TTY or piped) for token entry / confirmations. */
  stdin: unknown;
  stdout: BridgeWritable;
  stderr: BridgeWritable;
  /** Whether stdin is an interactive TTY (prompts are worth showing). */
  interactive: boolean;
  /** `--json` — suppress human-readable progress lines. */
  json: boolean;
  /** `--skip-auth` — the credential comes from the env override / binary. */
  skipAuth: boolean;
  /** Injected keychain backend (tests), or undefined for the OS keyring. */
  keychain: KeychainBackend | undefined;
  /** The connector's report entry; the bridge mutates it in place. */
  report: BridgeReport;
  /** connector → discovery verb, for the closing "discovery skipped" recap. */
  discoverySkips: Map<string, string>;
  /** connector → manual-steps checklist, for the closing re-surface. */
  manualSteps: Map<string, readonly string[]>;
}

/** One connector's onboarding bridge. */
export interface OnboardBridge {
  readonly connector: string;
  /**
   * Drive the connector's setup end to end (token → probe → config slice).
   * Returns an exit code to abort the whole wizard, or `undefined` to continue.
   */
  run(deps: OnboardBridgeDeps): Promise<number | undefined>;
}

/** Lazy loaders per connector (keys cross-checked by the completeness test). */
const BRIDGES: Record<string, () => Promise<OnboardBridge>> = {
  slack: () => import("./slack-bridge.ts").then((m) => m.slackOnboardBridge),
};

/** The bridge for a connector, or `null` when it uses the generic verbs. */
export async function loadOnboardBridge(connector: string): Promise<OnboardBridge | null> {
  const loader = BRIDGES[connector];
  return loader ? await loader() : null;
}

/** Connector names with a registered bridge (for the completeness cross-check). */
export function onboardBridgeNames(): string[] {
  return Object.keys(BRIDGES).sort();
}
