/**
 * Auth-test failure classification + recovery advice for `suasor onboard`
 * (Issue #567 item 1).
 *
 * An `auth test` probe rejects for two very different reasons that used to get
 * the same "token saved; fix it and re-run `auth test`" advice:
 *
 * - the API could not be reached at all (offline laptop, proxy, DNS) — the
 *   token may be perfectly fine, and `auth set` is the *wrong* command to
 *   reach for;
 * - the API answered and rejected the credential — re-pasting via `auth set`
 *   IS the fix.
 *
 * The probe surfaces the raw exception (e.g. Bun's bare `fetch failed`), so the
 * classification is a heuristic over well-known transport error shapes. It is
 * deliberately conservative: anything not recognizably a transport failure is
 * treated as a credential problem, because that advice (`auth set` then
 * `auth test`) is still recoverable even when misapplied, while "check
 * connectivity" on a revoked token sends the user in circles.
 *
 * Pure string logic (no imports): shared by the wizard's immediate per-connector
 * line, the slack onboarding bridge, and the closing recap, so all three name
 * the same recovery command for the same failure.
 */

/** How an `auth test` failure should be read: transport vs credential. */
export type AuthFailureKind = "network" | "credential";

/**
 * Transport-failure shapes seen from Bun / undici / Node `fetch`: the bare
 * `fetch failed` wrapper, libuv errno codes, undici error codes, and the
 * connection wording Bun's own error classes use.
 */
const NETWORK_ERROR_PATTERN =
  /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENETDOWN|EPIPE|UND_ERR|ConnectionRefused|ConnectionClosed|socket hang up|network request failed|timed out|timeout/i;

/** Classify a probe failure message (best-effort; defaults to `credential`). */
export function classifyAuthFailure(detail: string): AuthFailureKind {
  return NETWORK_ERROR_PATTERN.test(detail) ? "network" : "credential";
}

/**
 * The recovery sentence for a failed probe, naming the command that actually
 * fixes the classified failure. `accountFlag` is the ` --account <name>` suffix
 * (empty for a flat run) — without it, a multi-account `auth test` either
 * refuses as ambiguous or tests the wrong account (ADR-0050).
 */
export function authFailureAdvice(
  kind: AuthFailureKind,
  connector: string,
  accountFlag = "",
): string {
  const test = `suasor ${connector} auth test${accountFlag}`;
  if (kind === "network") {
    return `could not reach the ${connector} API — check connectivity, then re-run \`${test}\``;
  }
  return `token saved but rejected — re-store with \`suasor ${connector} auth set${accountFlag}\`, then re-run \`${test}\``;
}
