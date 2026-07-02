/**
 * Build-target detection + the standalone-binary feature gate (ADR-0010, Issue
 * #167).
 *
 * The standalone single binary (`bun build --compile`) ships the Suasor core
 * plus `sqlite-vec`, but keeps the heavier pieces **external** to stay light
 * (docs/guide/install.md#binary-scope):
 *
 *  - the OS-keychain secret store (`@napi-rs/keyring`) — so keychain-backed
 *    onboarding (`<connector> auth set`) is unavailable in the binary;
 *  - the heavier connector SDKs (Slack / Microsoft Graph / Google / Box / Web) —
 *    so `<connector> sync` for those connectors is unavailable;
 *  - the bundled `docs/skills` directory — so `skills install` / `skills list`
 *    are unavailable.
 *
 * Run those in the binary and you would otherwise hit an opaque
 * `Cannot find module` / keyring failure deep inside `execute`. This module
 * turns that into a single, human-readable, up-front error pointing at the npm
 * (Bun) or Docker channel, plus the env-override escape hatch where one exists.
 *
 * Detection is a pure predicate over `Bun.main` so it is unit-testable on CI
 * (which never runs as a compiled binary): a `--compile` build resolves its
 * entry module under Bun's virtual filesystem root (`/$bunfs/...` on POSIX,
 * `B:\~BUN\...` on Windows), whereas a normal `bun run` / `bunx` resolves a real
 * on-disk path. The gate itself (`standaloneGate`) is likewise pure over an
 * injected `isBinary` flag so command tests can drive both build types.
 */
import { docsUrl } from "./doc-ref.ts";

/** Doc anchor pointing at the binary-scope caveat in the install guide. */
export const BINARY_SCOPE_DOC = docsUrl("guide/install.md#binary-scope");

/**
 * True when `main` (the value of `Bun.main`) resolves under a compiled-binary
 * virtual filesystem root, i.e. this is a `bun build --compile` standalone
 * binary rather than a `bun run` / `bunx` invocation.
 *
 * Bun embeds the entry module under `/$bunfs/root/...` (POSIX) or `B:\~BUN\...`
 * (Windows) in a compiled binary; a normal run resolves a real path. Matching is
 * deliberately lenient (substring / drive-prefix) to tolerate Bun internal path
 * shape changes across versions.
 */
export function isStandaloneBinary(main: string | undefined): boolean {
  if (!main) return false;
  return main.includes("$bunfs") || main.includes("~BUN") || /^[A-Za-z]:[\\/]~BUN/.test(main);
}

/**
 * Env var that forces the build-type detection, overriding the `Bun.main`
 * probe. `1` / `true` ⇒ treat as the standalone binary; `0` / `false` ⇒ treat
 * as a normal build. The injection seam the gate tests drive (the suite runs
 * under `bun test`, never as a compiled binary, so it can't reach the binary
 * branch for real). Unset ⇒ fall back to the `Bun.main` probe.
 */
export const FORCE_BINARY_ENV = "SUASOR_FORCE_BINARY";

/**
 * Read whether the *current* process is a standalone compiled binary. Isolated
 * so the `Bun.main` global access (and the {@link FORCE_BINARY_ENV} test
 * override) live in one place and the predicate above stays pure/testable.
 *
 * @param env environment map (defaults to `process.env`); injectable for tests.
 */
export function currentBuildIsBinary(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const forced = env[FORCE_BINARY_ENV];
  if (forced !== undefined && forced !== "") {
    return forced === "1" || forced.toLowerCase() === "true";
  }
  const g = globalThis as { Bun?: { main?: string } };
  return isStandaloneBinary(g.Bun?.main);
}

/**
 * Build the human-readable error a gated command emits when run in the
 * standalone binary. `feature` names the unavailable capability; `hint` (when
 * given) describes the escape hatch that still works in the binary (e.g. the env
 * override for credentials).
 */
export function binaryUnsupportedMessage(feature: string, hint?: string): string {
  const lines = [
    `error: ${feature} is not available in the standalone binary.`,
    "Use the npm (Bun) package or the Docker image for the full feature set —",
    `see ${BINARY_SCOPE_DOC}`,
  ];
  if (hint) lines.push(`hint: ${hint}`);
  return `${lines.join("\n")}\n`;
}

/** Outcome of the standalone gate: either pass through, or block with a message. */
export type GateResult = { ok: true } | { ok: false; message: string };

/**
 * Decide whether a binary-unsupported command may run. Pure over an injected
 * `isBinary` flag (defaults to the current build) so command tests can drive
 * both build types without compiling.
 *
 * @param feature  human-readable name of the unavailable capability.
 * @param options.hint  escape-hatch guidance appended to the error (optional).
 * @param options.isBinary  override the build-type detection (tests).
 */
export function standaloneGate(
  feature: string,
  options: { hint?: string; isBinary?: boolean } = {},
): GateResult {
  const isBinary = options.isBinary ?? currentBuildIsBinary();
  if (!isBinary) return { ok: true };
  return { ok: false, message: binaryUnsupportedMessage(feature, options.hint) };
}
