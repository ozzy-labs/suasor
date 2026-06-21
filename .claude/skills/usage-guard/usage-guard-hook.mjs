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

import { getUsage, readCache, resolveThreshold } from "./usage-check.mjs";

// PreToolUse "deny" is signaled to the harness with exit code 2 (stderr/JSON is
// surfaced to the model); 0 = allow. Keep these named for clarity.
const EXIT_ALLOW = 0;
const EXIT_DENY = 2;

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
 * Run the hook end to end. Returns the intended exit code (the CLI wrapper
 * applies it). All effects (warn / deny output) go through injected sinks so
 * tests can assert without spawning a process.
 *
 * @param {object} [deps]
 * @param {() => Promise<string>} [deps.readStdinImpl]
 * @param {() => Promise<object|null>} [deps.resolveUsageImpl]
 * @param {NodeJS.ProcessEnv} [deps.env]
 * @param {() => number} [deps.now]
 * @param {(msg: string) => void} [deps.warn]
 * @param {(msg: string) => void} [deps.deny]   // sink for the deny reason
 * @returns {Promise<number>} exit code (0 allow / 2 deny)
 */
export async function run({
  readStdinImpl = () => readStdin(),
  resolveUsageImpl = () => resolveUsage(),
  env = process.env,
  now = Date.now,
  warn = (msg) => process.stderr.write(`${msg}\n`),
  deny = (msg) => process.stderr.write(`${msg}\n`),
} = {}) {
  const threshold = resolveThreshold(env);
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

  const { allow, reason } = decide(usage, threshold, now);
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
