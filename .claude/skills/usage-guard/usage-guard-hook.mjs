#!/usr/bin/env node
// usage-guard-hook — PreToolUse global mid-unit ceiling for usage-guard (#123).
//
// Wired into ~/.claude/settings.local.json as a PreToolUse hook, this fires on
// EVERY tool call (including ones originating inside subagents, which carry an
// `agent_id` in the hook payload). It is the in-flight ceiling that drive's
// usage-guard checkpoint (#122; default-on as of #130) cannot provide: the
// checkpoint only pauses at resumable-unit boundaries, while a long unit can
// blow past the threshold mid-flight. The hook stops that.
//
// Signal source: it FIRST reads the cache that usage-check.mjs (#121) writes
// (`~/.claude/usage-guard/cache.json`, 30–60s TTL). On a hot cache it never
// touches the OAuth endpoint, so enabling the hook does NOT spam the endpoint on
// every tool call. On a COLD/stale cache it falls through to getUsage (which is
// itself cache-first and re-fetches at most once per TTL) AND writes the result
// back to the cache (self-sustaining), so a long run with the hook alone — even
// without usage-check.mjs having run first — converges to a single fetch per TTL
// instead of re-fetching on every tool call (#135). We import readCache +
// getUsage from the sibling usage-check.mjs so the cache path / TTL / decision
// logic live in exactly one place (M2: no `.claude/skills/...` path literal here
// either; the cache path is the HOME-anchored one usage-check.mjs owns).
//
// Decision (PreToolUse contract):
//   - over threshold → DENY. Emit a JSON decision AND exit 2 so the tool call
//     is blocked even on older harnesses that key off the exit code. The deny
//     reason includes the reset time (resets_at as local HH:MM).
//   - under threshold → ALLOW (exit 0, no output).
//   - usage unreadable (no cache + no usable signal, parse error, etc.) →
//     fail-open: ALLOW + a warning on stderr. The guard never hard-stops on its
//     own bug.
//
// Design-for-tests: the pure decision is `decide(usage, threshold, now)`; it
// takes a usage JSON object (the shape usage-check.mjs emits) and returns
// `{ allow, reason }` with no I/O, so tests can feed usage without real files.

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DISABLE_PATH,
  getUsage,
  HOOK_STATE_PATH,
  readCache,
  resolveThreshold,
} from "./usage-check.mjs";

// PreToolUse "deny" is signaled to the harness with exit code 2 (stderr/JSON is
// surfaced to the model); 0 = allow. Keep these named for clarity.
const EXIT_ALLOW = 0;
const EXIT_DENY = 2;

// Debounce / spike-rejection defaults (#139 (b)(c)). A lone over-threshold
// reading does NOT deny; only DEBOUNCE_COUNT consecutive over readings do, so a
// single transient spike can never hard-stop the session.
const DEFAULT_DEBOUNCE_COUNT = 2;
// A jump to ≥threshold within this many seconds of a comfortably sub-threshold
// reading is physically impossible (no consumption happened in between) → treat
// the over reading as a suspect spike and allow it.
const DEFAULT_SPIKE_WINDOW_SECONDS = 120;
// "Comfortably sub-threshold" = the prior good reading was below
// (threshold - SPIKE_DELTA). A wide gap closing in seconds is the spike signal.
const DEFAULT_SPIKE_DELTA = 25;

/**
 * Format an ISO `resets_at` as a local `HH:MM` string for the deny message.
 * Returns null when the input is missing or unparseable.
 * @param {string|null|undefined} resetsAt
 * @returns {string|null}
 */
export function formatResetTime(resetsAt) {
  if (!resetsAt || typeof resetsAt !== "string") return null;
  const ms = Date.parse(resetsAt);
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * Pure decision: given a usage result (the JSON usage-check.mjs emits), decide
 * whether to allow or deny the tool call.
 *
 * - `usage` null/undefined or not an object → fail-open ALLOW (caller warns).
 * - `usage.ok === false` (a window is at/over threshold) → DENY with a reason
 *   that names the exceeded windows and the reset time.
 * - otherwise → ALLOW.
 *
 * `threshold` and `now` are accepted for message context and testability; the
 * ok/not-ok call itself was already made by usage-check.mjs (`usage.ok`), so we
 * do not re-derive it here — we only build the human reason.
 *
 * @param {object|null|undefined} usage
 * @param {number} [threshold]
 * @param {() => number} [now]
 * @returns {{ allow: boolean, reason: string|null }}
 */
export function decide(usage, threshold = 95, now = Date.now) {
  if (!usage || typeof usage !== "object") {
    return { allow: true, reason: null };
  }
  // fail-open is itself an "ok" usage; allow without ceremony.
  if (usage.ok !== false) {
    return { allow: true, reason: null };
  }

  // (#139 (d)) A suspected reflection lag is the prior window's residue still
  // echoing through the endpoint just after a reset, NOT a genuine throttle.
  // ALLOW at the hook layer — the resumable-unit boundary checkpoint will still
  // stop a real overage. Without this the hook would deny on a transient 100%
  // right at a window boundary and hard-stop the session (the #139 incident).
  if (usage.suspected_reflection_lag === true) {
    return { allow: true, reason: null };
  }

  const exceeded = [];
  if (usage.five_hour && Number(usage.five_hour.utilization) >= threshold) {
    exceeded.push(`5h ${Math.round(Number(usage.five_hour.utilization))}%`);
  }
  if (usage.seven_day && Number(usage.seven_day.utilization) >= threshold) {
    exceeded.push(`7d ${Math.round(Number(usage.seven_day.utilization))}%`);
  }
  const windows = exceeded.length > 0 ? exceeded.join(", ") : "usage";

  const resetHHMM = formatResetTime(usage.resets_at);
  let reason = `usage-guard: Usage Limit reached (${windows} ≥ ${threshold}%). Tool call blocked to avoid hitting 100%.`;
  if (resetHHMM) {
    reason += ` Quota resets at ${resetHHMM}.`;
  } else if (typeof usage.wait_seconds === "number" && usage.wait_seconds > 0) {
    // No parseable resets_at but we know how long: surface minutes as a hint.
    const mins = Math.ceil(usage.wait_seconds / 60);
    reason += ` Quota resets in ~${mins} min.`;
  }
  // `now` is part of the signature for test determinism / future use.
  void now;
  return { allow: false, reason };
}

/**
 * Build the degradation warning for a non-endpoint usage source.
 *
 * `fail-open` means BOTH the OAuth endpoint and the JSONL fallback failed, so
 * the guard is effectively OFF (it can no longer detect an over-threshold
 * window). `jsonl` means only the coarse local fallback is in play. Either way
 * the work is still allowed, but the operator/caller must know the guard is
 * degraded.
 *
 * @param {string} source the usage `source` (e.g. "fail-open", "jsonl")
 * @param {string} origin "main session" | "subagent <id>"
 * @returns {string}
 */
export function degradedSourceWarning(source, origin) {
  if (source === "fail-open") {
    return `⚠️ usage-guard DEGRADED: source=fail-open (${origin}) — the budget signal is unavailable (OAuth endpoint + JSONL both failed); the guard is NOT actually monitoring usage. Allowing, but you may hit 100%. See SKILL.md §環境要件.`;
  }
  return `⚠️ usage-guard degraded: source=${source} (${origin}) — live OAuth signal unavailable; using a coarse fallback. Allowing, but the ceiling may be inaccurate.`;
}

/**
 * Read the entire hook stdin payload.
 * @param {NodeJS.ReadableStream} [stream]
 * @returns {Promise<string>}
 */
export function readStdin(stream = process.stdin) {
  return new Promise((resolve) => {
    let data = "";
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve(data);
    };
    stream.setEncoding?.("utf8");
    stream.on("data", (chunk) => {
      data += chunk;
    });
    stream.on("end", done);
    stream.on("error", done);
    // If nothing is piped (TTY), don't hang the tool call.
    if (stream.isTTY) done();
  });
}

/**
 * Parse the hook payload and pull out `agent_id` (present for subagent-
 * originated calls) for logging. Tolerates empty / malformed input.
 * @param {string} raw
 * @returns {{ agentId: string|null }}
 */
export function parsePayload(raw) {
  if (!raw?.trim()) return { agentId: null };
  try {
    const obj = JSON.parse(raw);
    const agentId = obj?.agent_id ?? obj?.agentId ?? null;
    return { agentId: typeof agentId === "string" ? agentId : null };
  } catch {
    return { agentId: null };
  }
}

/**
 * Resolve the usage signal for the hook decision.
 *
 * Reads the cache usage-check.mjs writes FIRST (no endpoint hit on a hot
 * cache). If the cache is cold/stale, falls through to `getUsage` — which is
 * still cache-first and only re-fetches once per TTL, so a fleet of tool calls
 * does not stampede the endpoint. Returns `null` on any failure so the caller
 * fails open.
 *
 * @param {object} [deps]
 * @param {typeof readCache} [deps.readCacheImpl]
 * @param {typeof getUsage} [deps.getUsageImpl]
 * @returns {Promise<object|null>}
 */
export async function resolveUsage({ readCacheImpl = readCache, getUsageImpl = getUsage } = {}) {
  try {
    const cached = await readCacheImpl();
    if (cached) return { ...cached, source: "cache" };
  } catch {
    // fall through to getUsage
  }
  try {
    return await getUsageImpl();
  } catch {
    return null;
  }
}

/**
 * Resolve the consecutive-deny debounce count (env override → default).
 * `USAGE_GUARD_DEBOUNCE_COUNT` overrides the default (2). Set it to `1` to deny
 * on the first over reading (legacy single-reading behaviour). Values < 1,
 * non-finite, or blank fall back to the default (a 0/negative count would never
 * deny). Fractional values are floored.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function resolveDebounceCount(env = process.env) {
  const raw = env?.USAGE_GUARD_DEBOUNCE_COUNT;
  if (raw === undefined || raw === null || String(raw).trim() === "") return DEFAULT_DEBOUNCE_COUNT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_DEBOUNCE_COUNT;
  return Math.floor(n);
}

/**
 * Resolve the spike-rejection window in seconds (env override → default).
 * `USAGE_GUARD_SPIKE_WINDOW_SECONDS` overrides the default (120).
 * Negative/non-finite/blank → default. 0 disables spike rejection.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function resolveSpikeWindow(env = process.env) {
  const raw = env?.USAGE_GUARD_SPIKE_WINDOW_SECONDS;
  if (raw === undefined || raw === null || String(raw).trim() === "")
    return DEFAULT_SPIKE_WINDOW_SECONDS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_SPIKE_WINDOW_SECONDS;
  return n;
}

/**
 * Resolve the spike-rejection delta in percent (env override → default).
 * `USAGE_GUARD_SPIKE_DELTA` overrides the default (25). Negative/non-finite/
 * blank → default.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function resolveSpikeDelta(env = process.env) {
  const raw = env?.USAGE_GUARD_SPIKE_DELTA;
  if (raw === undefined || raw === null || String(raw).trim() === "") return DEFAULT_SPIKE_DELTA;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_SPIKE_DELTA;
  return n;
}

/**
 * Read the cross-call hook state (debounce counter + last good reading).
 * Tolerates a missing / malformed file → `{}` (so the first run starts clean).
 * @param {object} [deps]
 * @param {typeof readFile} [deps.readFileImpl]
 * @param {string} [deps.statePath]
 * @returns {Promise<object>}
 */
export async function readHookState({ readFileImpl = readFile, statePath = HOOK_STATE_PATH } = {}) {
  try {
    const parsed = JSON.parse(await readFileImpl(statePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Persist the cross-call hook state (best-effort; failures are swallowed so the
 * hook never hard-stops on a state write error).
 * @param {object} state
 * @param {object} [deps]
 * @param {typeof writeFile} [deps.writeFileImpl]
 * @param {typeof mkdir} [deps.mkdirImpl]
 * @param {string} [deps.statePath]
 */
export async function writeHookState(
  state,
  { writeFileImpl = writeFile, mkdirImpl = mkdir, statePath = HOOK_STATE_PATH } = {},
) {
  try {
    await mkdirImpl(join(statePath, ".."), { recursive: true });
    await writeFileImpl(statePath, JSON.stringify(state));
  } catch {
    // best-effort state; ignore.
  }
}

/**
 * Pure hook decision with debounce + spike rejection (#139 (b)(c)(d)).
 *
 * Layered on top of `decide()`: it consumes the prior cross-call state and
 * returns the allow/deny verdict PLUS the next state to persist and a
 * `degraded` tag for the caller to surface as a warning.
 *
 * Order of precedence (each ALLOWs without counting toward debounce):
 *   1. usage missing / fail-open / under threshold → ALLOW, reset counter; a
 *      sub-threshold reading is recorded as the latest "good" baseline.
 *   2. (d) suspected reflection lag → ALLOW (`degraded:"lag"`), reset counter.
 *   3. (c) implausible spike from a recent comfortably-sub-threshold baseline →
 *      ALLOW (`degraded:"spike"`), reset counter.
 *   4. (b) genuine over reading → increment the consecutive counter; ALLOW
 *      (`degraded:"debounce"`) until it reaches `debounceCount`, then DENY.
 *
 * @param {object|null|undefined} usage usage JSON from usage-check.mjs
 * @param {object|null|undefined} prevState prior state from readHookState
 * @param {object} [opts]
 * @param {number} [opts.threshold]
 * @param {number} [opts.debounceCount]
 * @param {number} [opts.spikeWindowSeconds]
 * @param {number} [opts.spikeDelta]
 * @param {() => number} [opts.now]
 * @returns {{ allow: boolean, reason: string|null, degraded: string|null, nextState: object }}
 */
export function evaluateHookDecision(
  usage,
  prevState,
  {
    threshold = 95,
    debounceCount = DEFAULT_DEBOUNCE_COUNT,
    spikeWindowSeconds = DEFAULT_SPIKE_WINDOW_SECONDS,
    spikeDelta = DEFAULT_SPIKE_DELTA,
    now = Date.now,
  } = {},
) {
  const nowMs = now();
  const prev = prevState && typeof prevState === "object" ? prevState : {};
  const prevConsecutive = Number(prev.consecutive_over) || 0;
  const lastGood = prev.last_good && typeof prev.last_good === "object" ? prev.last_good : null;

  // 1a. Unreadable usage → fail-open ALLOW, reset counter (keep last_good).
  if (!usage || typeof usage !== "object") {
    return { allow: true, reason: null, degraded: null, nextState: resetState(lastGood) };
  }
  // 1b. Under threshold → ALLOW; record this as the latest good baseline.
  if (usage.ok !== false) {
    const good = {
      five_hour: Number(usage.five_hour?.utilization) || 0,
      seven_day: Number(usage.seven_day?.utilization) || 0,
      at: nowMs,
    };
    return {
      allow: true,
      reason: null,
      degraded: null,
      nextState: { consecutive_over: 0, last_good: good },
    };
  }

  // From here usage.ok === false (a window is at/over threshold).

  // 2. (d) reflection lag → ALLOW, do NOT count (transient by definition).
  if (usage.suspected_reflection_lag === true) {
    return { allow: true, reason: null, degraded: "lag", nextState: resetState(lastGood) };
  }

  // 3. (c) spike: a recent comfortably-sub-threshold baseline jumping to
  // ≥threshold within seconds is physically impossible → suspect, ALLOW.
  if (lastGood && typeof lastGood.at === "number" && spikeWindowSeconds > 0) {
    const ageS = (nowMs - lastGood.at) / 1000;
    const maxPrevUtil = Math.max(Number(lastGood.five_hour) || 0, Number(lastGood.seven_day) || 0);
    if (ageS >= 0 && ageS <= spikeWindowSeconds && maxPrevUtil < threshold - spikeDelta) {
      return { allow: true, reason: null, degraded: "spike", nextState: resetState(lastGood) };
    }
  }

  // 4. (b) debounce: a genuine over reading. Increment the consecutive counter;
  // DENY only once it reaches the debounce count.
  const consecutive = prevConsecutive + 1;
  const nextState = { consecutive_over: consecutive, last_good: lastGood };
  if (consecutive < debounceCount) {
    return { allow: true, reason: null, degraded: "debounce", nextState };
  }
  const { reason } = decide(usage, threshold, now);
  return { allow: false, reason, degraded: null, nextState };
}

/**
 * Build a "counter reset" next-state that preserves the last good baseline.
 * @param {object|null} lastGood
 * @returns {object}
 */
function resetState(lastGood) {
  return lastGood ? { consecutive_over: 0, last_good: lastGood } : { consecutive_over: 0 };
}

/**
 * Run the hook end to end. Returns the intended exit code (the CLI wrapper
 * applies it). All effects (warn / deny output) go through injected sinks so
 * tests can assert without spawning a process.
 *
 * @param {object} [deps]
 * @param {() => Promise<string>} [deps.readStdinImpl]
 * @param {() => Promise<object|null>} [deps.resolveUsageImpl]
 * @param {() => boolean} [deps.killSwitchImpl]   // true → hook disabled (no-op)
 * @param {() => Promise<object>} [deps.readStateImpl]
 * @param {(s: object) => Promise<void>} [deps.writeStateImpl]
 * @param {NodeJS.ProcessEnv} [deps.env]
 * @param {() => number} [deps.now]
 * @param {(msg: string) => void} [deps.warn]
 * @param {(msg: string) => void} [deps.deny]   // sink for the deny reason
 * @returns {Promise<number>} exit code (0 allow / 2 deny)
 */
export async function run({
  readStdinImpl = () => readStdin(),
  resolveUsageImpl = () => resolveUsage(),
  killSwitchImpl = () => existsSync(DISABLE_PATH),
  readStateImpl = () => readHookState(),
  writeStateImpl = (s) => writeHookState(s),
  env = process.env,
  now = Date.now,
  warn = (msg) => process.stderr.write(`${msg}\n`),
  deny = (msg) => process.stderr.write(`${msg}\n`),
} = {}) {
  // (#139 (a)) File kill-switch — the escape hatch. When
  // `~/.claude/usage-guard/DISABLE` exists the hook is an instant no-op, so an
  // operator can free a session a transient bad reading hard-stopped by running
  // `touch ~/.claude/usage-guard/DISABLE` from a `!` shell (no settings edit).
  // Checked FIRST, before any I/O, and itself fail-open (a check error → not
  // disabled → continue normally).
  let disabled = false;
  try {
    disabled = !!killSwitchImpl();
  } catch {
    disabled = false;
  }
  if (disabled) {
    warn(`usage-guard hook: disabled via kill-switch (${DISABLE_PATH}); allowing (no-op)`);
    return EXIT_ALLOW;
  }

  const threshold = resolveThreshold(env);
  const debounceCount = resolveDebounceCount(env);
  const spikeWindowSeconds = resolveSpikeWindow(env);
  const spikeDelta = resolveSpikeDelta(env);
  const { agentId } = parsePayload(await readStdinImpl());
  const origin = agentId ? `subagent ${agentId}` : "main session";

  const usage = await resolveUsageImpl();
  if (usage === null) {
    // fail-open: signal unreadable → allow + warn (never hard-stop on our bug).
    warn(`usage-guard hook: usage signal unavailable (${origin}); allowing (fail-open)`);
    return EXIT_ALLOW;
  }

  // Degradation visibility: a non-endpoint source means the live OAuth signal
  // is unavailable (especially `fail-open`, where the guard is effectively OFF).
  // We still ALLOW, but surface the degradation so it never goes unnoticed.
  const source = typeof usage.source === "string" ? usage.source : null;
  if (source !== null && source !== "endpoint" && source !== "cache") {
    warn(degradedSourceWarning(source, origin));
  }

  const prevState = await readStateImpl();
  const { allow, reason, degraded, nextState } = evaluateHookDecision(usage, prevState, {
    threshold,
    debounceCount,
    spikeWindowSeconds,
    spikeDelta,
    now,
  });
  // Persist the debounce/spike state for the next tool call (best-effort).
  await writeStateImpl(nextState);

  // Surface why an over-threshold reading was ALLOWed (lag/spike/debounce) so a
  // soft-allow never looks like the guard simply being off.
  if (degraded === "lag") {
    warn(
      `usage-guard hook: suspected reflection lag — over threshold but barely past a window reset (${origin}); allowing (the boundary checkpoint will still stop a genuine overage). See SKILL.md §振る舞い.`,
    );
  } else if (degraded === "spike") {
    warn(
      `usage-guard hook: implausible usage spike from a recent sub-threshold reading (${origin}); treating as suspect and allowing. If real, consecutive checks will debounce-deny.`,
    );
  } else if (degraded === "debounce") {
    warn(
      `usage-guard hook: over threshold (${origin}) but below the consecutive-deny count (debounce); allowing once more before blocking.`,
    );
  }

  if (allow) return EXIT_ALLOW;

  deny(`${reason} [origin: ${origin}]`);
  return EXIT_DENY;
}

// CLI entry — only when executed directly (not when imported by tests).
const __isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (__isMain) {
  run()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      // Any unexpected error in the hook itself must fail open, never block.
      process.stderr.write(
        `usage-guard hook: fatal ${err?.message ?? err}; allowing (fail-open)\n`,
      );
      process.exitCode = EXIT_ALLOW;
    });
}
