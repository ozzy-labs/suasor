#!/usr/bin/env node
// usage-check — deterministic Claude Code budget signal for usage-guard.
//
// Reads the live OAuth usage utilization for the two limit windows Claude Code
// enforces (5-hour "Current" and 7-day "Weekly") and decides whether work may
// continue (both windows below the threshold) or must pause. Shipped verbatim
// as a skill extra file alongside SKILL.md (user scope under HOME, dogfood under
// the repo) — it is always resolved as the sibling of SKILL.md.
//
// M2 (path-literal note): the build's rewriteSkillRefsToUserScope rewrites
// skill-dir path literals (the `agents`/`claude` skills dirs). The HOME-anchored
// paths used here (the credentials file, the projects transcripts dir, and the
// usage-guard cache file — all under ~/.claude/ but NOT under a skills dir) do
// NOT match that pattern, so they survive the dist build intact. Crucially, no
// functional path literal here is written in the rewritable skills-dir form.
//
// Output (stdout, single JSON line):
//   { five_hour, seven_day, ok, wait_seconds, resets_at, resume_buffer_seconds,
//     suspected_reflection_lag, source }
//   - five_hour / seven_day: { utilization (0-100), resets_at (ISO|null) }
//   - ok:           both windows' utilization < threshold (default 95)
//   - wait_seconds: seconds until the LATEST resets_at among exceeded windows
//                   PLUS the post-reset resume buffer (0 when ok). Derived from
//                   `resets_at` minus now, plus resume_buffer_seconds. When a
//                   reflection lag is suspected (see below) this collapses to a
//                   short recheck interval instead of a full window.
//   - resets_at:    that same latest exceeded resets_at, UNCHANGED by the buffer
//                   (the window edge; the planned resume = resets_at + buffer)
//   - resume_buffer_seconds: the post-reset safety margin folded into
//                   wait_seconds (default 300; 0 restores the legacy behaviour)
//   - suspected_reflection_lag: true when an exceeded window is also barely past
//                   its boundary (elapsed = period - (resets_at - now) < epsilon).
//                   This is the "reset happened but the server-side utilization
//                   still shows the previous window's residue" contradiction
//                   (#133). When set, wait_seconds collapses to a SHORT recheck
//                   interval so the caller re-fetches the real post-lag value
//                   soon instead of idling a full window; resets_at stays the
//                   raw window edge. Such results are NOT cached (so the next
//                   check hits the live endpoint, not the stale lagged value).
//   - source:       "endpoint" | "jsonl" | "fail-open" | "cache"
//
// Fail-open: if the endpoint fails AND the JSONL fallback fails, emit
// { ok: true, ... source: "fail-open" } and a warning on stderr so the guard
// never hard-stops on its own bug.
//
// This is a plain .mjs (NOT a Workflow script): Date.now() / real fetch / real
// fs are fine. Pure/injectable functions are exported for tests.

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20";
const CLAUDE_CODE_VERSION = "2.0.0";
const DEFAULT_THRESHOLD = 95;
// Post-reset resume buffer (seconds). Server-side `utilization` can lag the
// window reset and ScheduleWakeup fires late, so resuming a few minutes AFTER
// resets_at avoids re-entering a still-throttled window and re-bouncing. 0
// restores the legacy "resume exactly at resets_at" behaviour.
const DEFAULT_RESUME_BUFFER_SECONDS = 300;
const DEFAULT_CACHE_TTL_MS = 45_000; // 30–60s window so the #123 hook can share it.
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;
// Reflection-lag detection (#133). After a window resets, the server-side
// `utilization` can briefly still report the PREVIOUS window's residue (e.g.
// 100% at 5 minutes into a fresh 5h window). An exceeded window whose elapsed
// time since its boundary is below this epsilon is treated as "suspected
// reflection lag" rather than a genuine throttle.
const DEFAULT_LAG_EPSILON_SECONDS = 900; // 15 min boundary-proximity window.
// When a lag is suspected we wait only this short interval before re-checking
// (instead of a full window + buffer) so the real post-lag value is picked up
// quickly. resets_at is left at the raw window edge (information preserved).
const DEFAULT_LAG_RECHECK_SECONDS = 180; // 3 min recheck cadence.
// Per-window period lengths in SECONDS, used to compute elapsed-since-boundary
// for the lag check: elapsed = period - (resets_at - now).
const FIVE_HOUR_PERIOD_S = FIVE_HOUR_MS / 1000; // 18000
const SEVEN_DAY_PERIOD_S = SEVEN_DAY_MS / 1000; // 604800

// HOME-anchored paths, built with path.join so no rewritable skills-dir literal
// ever appears in source (M2).
const CREDENTIALS_PATH = join(homedir(), ".claude", ".credentials.json");
const PROJECTS_DIR = join(homedir(), ".claude", "projects");
// Cache lives OUTSIDE any skills dir so the #123 PreToolUse hook can read the
// same file (and so it is never wiped when the dogfood skills mirror is
// rebuilt).
const CACHE_PATH = join(homedir(), ".claude", "usage-guard", "cache.json");

/**
 * Resolve the threshold (env override → default).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function resolveThreshold(env = process.env) {
  const raw = env?.USAGE_GUARD_THRESHOLD;
  if (raw === undefined || raw === null || String(raw).trim() === "") return DEFAULT_THRESHOLD;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_THRESHOLD;
}

/**
 * Resolve the post-reset resume buffer in seconds (env override → default).
 *
 * `USAGE_GUARD_RESUME_BUFFER_SECONDS` overrides the default (300). A value of 0
 * restores the legacy "resume exactly at resets_at" behaviour. Negative or
 * non-finite values clamp to the default.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function resolveResumeBuffer(env = process.env) {
  const raw = env?.USAGE_GUARD_RESUME_BUFFER_SECONDS;
  if (raw === undefined || raw === null || String(raw).trim() === "")
    return DEFAULT_RESUME_BUFFER_SECONDS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RESUME_BUFFER_SECONDS;
  return n;
}

/**
 * Resolve the reflection-lag epsilon in seconds (env override → default).
 *
 * `USAGE_GUARD_LAG_EPSILON_SECONDS` overrides the default (900). An exceeded
 * window whose elapsed time since its boundary is below this value is treated
 * as suspected reflection lag (#133). Negative/non-finite/blank → default.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function resolveLagEpsilon(env = process.env) {
  const raw = env?.USAGE_GUARD_LAG_EPSILON_SECONDS;
  if (raw === undefined || raw === null || String(raw).trim() === "")
    return DEFAULT_LAG_EPSILON_SECONDS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_LAG_EPSILON_SECONDS;
  return n;
}

/**
 * Resolve the reflection-lag recheck interval in seconds (env override →
 * default).
 *
 * `USAGE_GUARD_LAG_RECHECK_SECONDS` overrides the default (180). When a lag is
 * suspected, `wait_seconds` collapses to this short cadence so the caller
 * re-fetches the real value soon (#133). Negative/non-finite/blank → default.
 * A value of 0 is rejected (collapses to default) because a zero recheck would
 * busy-loop.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function resolveLagRecheck(env = process.env) {
  const raw = env?.USAGE_GUARD_LAG_RECHECK_SECONDS;
  if (raw === undefined || raw === null || String(raw).trim() === "")
    return DEFAULT_LAG_RECHECK_SECONDS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LAG_RECHECK_SECONDS;
  return n;
}

/**
 * Read + parse the OAuth access token, honoring `expiresAt`.
 *
 * Re-reads the credentials file on EVERY call (no caching of the token) so a
 * refreshed token is picked up immediately.
 *
 * @param {object} [deps]
 * @param {(p: string, enc: string) => Promise<string>} [deps.readFileImpl]
 * @param {string} [deps.credentialsPath]
 * @param {() => number} [deps.now]
 * @returns {Promise<string|null>} the access token, or null when missing/expired.
 */
export async function readAccessToken({
  readFileImpl = readFile,
  credentialsPath = CREDENTIALS_PATH,
  now = Date.now,
} = {}) {
  let parsed;
  try {
    parsed = JSON.parse(await readFileImpl(credentialsPath, "utf8"));
  } catch {
    return null;
  }
  const oauth = parsed?.claudeAiOauth;
  const token = oauth?.accessToken;
  if (!token) return null;
  // expiresAt is epoch milliseconds. Treat an expired token as absent so we
  // fall through to the JSONL fallback rather than sending a dead Bearer.
  if (typeof oauth.expiresAt === "number" && oauth.expiresAt <= now()) return null;
  return token;
}

/**
 * Normalize one raw usage window (`{ utilization, resets_at }`-ish) into a
 * stable `{ utilization, resets_at }` shape. Tolerates missing fields and
 * `utilization` expressed as a 0–1 fraction (scaled to 0–100).
 *
 * @param {any} raw
 * @returns {{ utilization: number, resets_at: string|null }}
 */
export function normalizeWindow(raw) {
  if (!raw || typeof raw !== "object") return { utilization: 0, resets_at: null };
  let util = Number(raw.utilization);
  if (!Number.isFinite(util)) util = 0;
  if (util > 0 && util <= 1) util *= 100; // fraction → percent
  const resetsAt = raw.resets_at ?? raw.resetsAt ?? null;
  return { utilization: util, resets_at: typeof resetsAt === "string" ? resetsAt : null };
}

/**
 * Normalize the endpoint payload into `{ five_hour, seven_day }`.
 * @param {any} payload
 * @returns {{ five_hour: {utilization:number,resets_at:string|null}, seven_day: {utilization:number,resets_at:string|null} }}
 */
export function normalizeWindows(payload) {
  return {
    five_hour: normalizeWindow(payload?.five_hour ?? payload?.fiveHour),
    seven_day: normalizeWindow(payload?.seven_day ?? payload?.sevenDay),
  };
}

/**
 * Decide ok / wait_seconds / resets_at from two normalized windows.
 *
 * `ok` = both windows' utilization < threshold. When NOT ok, wait_seconds and
 * resets_at derive from the LATEST resets_at among the windows that exceeded
 * the threshold (the soonest the work could safely resume against all
 * exceeded windows).
 *
 * The optional post-reset `resumeBuffer` (seconds) is added to `wait_seconds`
 * ONLY when not ok, so the work resumes a margin AFTER the window edge (server
 * `utilization` can lag the reset). `resets_at` stays the raw window edge — the
 * planned resume time is `resets_at + resumeBuffer`, kept distinguishable.
 *
 * Reflection-lag (#133): for each exceeded window we also compute how long it
 * has been since that window's boundary
 * (`elapsed = period - (resets_at - now)`). If ANY exceeded window is barely
 * past its boundary (`elapsed < lagEpsilon`) the over-threshold reading is most
 * likely the previous window's residue still echoing through the endpoint, not
 * a genuine throttle. In that case `suspected_reflection_lag` is set and
 * `wait_seconds` collapses to the short `lagRecheck` interval (instead of a
 * full window + buffer) so the caller re-fetches the real value soon. `resets_at`
 * is preserved as the raw window edge in both cases.
 *
 * @param {{ five_hour: {utilization:number,resets_at:string|null}, seven_day: {utilization:number,resets_at:string|null} }} windows
 * @param {object} [opts]
 * @param {number} [opts.threshold]
 * @param {number} [opts.resumeBuffer] post-reset buffer in seconds (default 300)
 * @param {number} [opts.lagEpsilon] boundary-proximity window in seconds (default 900)
 * @param {number} [opts.lagRecheck] short recheck interval when lag suspected (default 180)
 * @param {() => number} [opts.now]
 * @returns {{ five_hour: object, seven_day: object, ok: boolean, wait_seconds: number, resets_at: string|null, resume_buffer_seconds: number, suspected_reflection_lag: boolean }}
 */
export function evaluate(
  windows,
  {
    threshold = DEFAULT_THRESHOLD,
    resumeBuffer = DEFAULT_RESUME_BUFFER_SECONDS,
    lagEpsilon = DEFAULT_LAG_EPSILON_SECONDS,
    lagRecheck = DEFAULT_LAG_RECHECK_SECONDS,
    now = Date.now,
  } = {},
) {
  // Pair each window with its period (seconds) so we can compute elapsed since
  // the window boundary for the reflection-lag check.
  const exceeded = [
    { w: windows.five_hour, periodS: FIVE_HOUR_PERIOD_S },
    { w: windows.seven_day, periodS: SEVEN_DAY_PERIOD_S },
  ].filter(({ w }) => w.utilization >= threshold);
  const ok = exceeded.length === 0;
  let resetsAt = null;
  let waitSeconds = 0;
  let suspectedReflectionLag = false;
  const nowMs = now();
  if (!ok) {
    // Latest resets_at among exceeded windows (max epoch); ignore unparseable.
    let latestMs = null;
    for (const { w, periodS } of exceeded) {
      if (!w.resets_at) continue;
      const ms = Date.parse(w.resets_at);
      if (Number.isNaN(ms)) continue;
      if (latestMs === null || ms > latestMs) {
        latestMs = ms;
        resetsAt = w.resets_at;
      }
      // elapsed since this window's boundary = period - (resets_at - now).
      // Small elapsed + over-threshold = the reset just happened but the
      // endpoint is still echoing the prior window's residue → lag suspected.
      const elapsedS = periodS - (ms - nowMs) / 1000;
      if (elapsedS >= 0 && elapsedS < lagEpsilon) suspectedReflectionLag = true;
    }
    if (suspectedReflectionLag) {
      // Don't idle a full window on a likely-stale 100%; re-check soon.
      waitSeconds = Math.max(1, Math.ceil(lagRecheck));
    } else if (latestMs !== null) {
      // wait = time to the window edge + the post-reset safety buffer.
      waitSeconds = Math.max(0, Math.ceil((latestMs - nowMs) / 1000)) + Math.max(0, resumeBuffer);
    }
  }
  return {
    five_hour: windows.five_hour,
    seven_day: windows.seven_day,
    ok,
    wait_seconds: waitSeconds,
    resets_at: resetsAt,
    resume_buffer_seconds: Math.max(0, resumeBuffer),
    suspected_reflection_lag: suspectedReflectionLag,
  };
}

/**
 * Fetch raw usage windows from the OAuth endpoint.
 *
 * @param {string} token
 * @param {object} [deps]
 * @param {typeof fetch} [deps.fetchImpl]
 * @returns {Promise<{ five_hour: object, seven_day: object }>}
 */
export async function fetchEndpointUsage(token, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(USAGE_ENDPOINT, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": OAUTH_BETA,
      "User-Agent": `claude-code/${CLAUDE_CODE_VERSION}`,
    },
  });
  if (!res.ok) {
    throw new Error(`usage endpoint HTTP ${res.status}`);
  }
  const payload = await res.json();
  return normalizeWindows(payload);
}

/**
 * Estimate usage windows from local session JSONL transcripts.
 *
 * Aggregates per-message `usage` token counts within the trailing 5h / 7d
 * windows from the per-project session transcripts under
 * `~/.claude/projects/<project>/<session>.jsonl`. This is a coarse fallback
 * used only when the endpoint is unavailable; utilization is reported as a best-
 * effort percentage of a configurable budget. resets_at is the window edge
 * (oldest counted message + window length).
 *
 * @param {object} [deps]
 * @param {(p: string, o?: any) => Promise<any>} [deps.readdirImpl]
 * @param {(p: string, enc: string) => Promise<string>} [deps.readFileImpl]
 * @param {string} [deps.projectsDir]
 * @param {() => number} [deps.now]
 * @param {number} [deps.fiveHourBudget]
 * @param {number} [deps.sevenDayBudget]
 * @returns {Promise<{ five_hour: object, seven_day: object }>}
 */
export async function aggregateJsonlUsage({
  readdirImpl = readdir,
  readFileImpl = readFile,
  projectsDir = PROJECTS_DIR,
  now = Date.now,
  // Coarse token budgets for utilization estimation. Intentionally generous —
  // the JSONL path only needs to be directionally correct as a fallback.
  fiveHourBudget = 8_000_000,
  sevenDayBudget = 80_000_000,
} = {}) {
  const nowMs = now();
  const files = [];
  const projectEntries = await readdirImpl(projectsDir, { withFileTypes: true });
  for (const entry of projectEntries) {
    if (!entry.isDirectory()) continue;
    const dir = join(projectsDir, entry.name);
    let inner;
    try {
      inner = await readdirImpl(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of inner) {
      if (f.isFile() && f.name.endsWith(".jsonl")) files.push(join(dir, f.name));
    }
  }
  if (files.length === 0) {
    throw new Error("no JSONL transcripts found");
  }

  let fiveHourTokens = 0;
  let sevenDayTokens = 0;
  let oldestFiveHourMs = null;
  let oldestSevenDayMs = null;

  for (const file of files) {
    let raw;
    try {
      raw = await readFileImpl(file, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let rec;
      try {
        rec = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const ts = rec?.timestamp;
      const tsMs = typeof ts === "string" ? Date.parse(ts) : Number(ts);
      if (!Number.isFinite(tsMs)) continue;
      const usage = rec?.message?.usage ?? rec?.usage;
      if (!usage) continue;
      const tokens =
        (Number(usage.input_tokens) || 0) +
        (Number(usage.output_tokens) || 0) +
        (Number(usage.cache_creation_input_tokens) || 0) +
        (Number(usage.cache_read_input_tokens) || 0);
      if (tokens <= 0) continue;
      const age = nowMs - tsMs;
      if (age >= 0 && age <= SEVEN_DAY_MS) {
        sevenDayTokens += tokens;
        if (oldestSevenDayMs === null || tsMs < oldestSevenDayMs) oldestSevenDayMs = tsMs;
        if (age <= FIVE_HOUR_MS) {
          fiveHourTokens += tokens;
          if (oldestFiveHourMs === null || tsMs < oldestFiveHourMs) oldestFiveHourMs = tsMs;
        }
      }
    }
  }

  const pct = (used, budget) => Math.min(100, (used / budget) * 100);
  const resetsFrom = (oldestMs, windowMs) =>
    oldestMs === null ? null : new Date(oldestMs + windowMs).toISOString();

  return {
    five_hour: {
      utilization: pct(fiveHourTokens, fiveHourBudget),
      resets_at: resetsFrom(oldestFiveHourMs, FIVE_HOUR_MS),
    },
    seven_day: {
      utilization: pct(sevenDayTokens, sevenDayBudget),
      resets_at: resetsFrom(oldestSevenDayMs, SEVEN_DAY_MS),
    },
  };
}

/**
 * Read a cached result if it is fresh (within ttlMs).
 * @param {object} deps
 * @returns {Promise<object|null>}
 */
export async function readCache({
  readFileImpl = readFile,
  cachePath = CACHE_PATH,
  ttlMs = DEFAULT_CACHE_TTL_MS,
  now = Date.now,
} = {}) {
  try {
    const parsed = JSON.parse(await readFileImpl(cachePath, "utf8"));
    if (typeof parsed?.cached_at !== "number") return null;
    if (now() - parsed.cached_at > ttlMs) return null;
    return parsed.result ?? null;
  } catch {
    return null;
  }
}

/**
 * Persist a result to the cache (best-effort; failures are swallowed).
 * @param {object} result
 * @param {object} deps
 */
export async function writeCache(
  result,
  { writeFileImpl, mkdirImpl, cachePath = CACHE_PATH, now = Date.now } = {},
) {
  if (!writeFileImpl) return;
  try {
    if (mkdirImpl) await mkdirImpl(join(cachePath, ".."), { recursive: true });
    await writeFileImpl(cachePath, JSON.stringify({ cached_at: now(), result }));
  } catch {
    // best-effort cache; ignore.
  }
}

/**
 * Orchestrate a full usage check: cache → endpoint → JSONL → fail-open.
 *
 * Every dependency is injectable so tests can stub the endpoint, JSONL, creds,
 * cache, and clock. `warn` defaults to stderr.
 *
 * @param {object} [deps]
 * @returns {Promise<{ five_hour: object, seven_day: object, ok: boolean, wait_seconds: number, resets_at: string|null, resume_buffer_seconds: number, suspected_reflection_lag: boolean, source: string }>}
 */
export async function getUsage({
  fetchImpl = fetch,
  readFileImpl = readFile,
  readdirImpl = readdir,
  writeFileImpl = writeFile,
  mkdirImpl = mkdir,
  env = process.env,
  now = Date.now,
  credentialsPath = CREDENTIALS_PATH,
  projectsDir = PROJECTS_DIR,
  cachePath = CACHE_PATH,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  warn = (msg) => process.stderr.write(`${msg}\n`),
} = {}) {
  const threshold = resolveThreshold(env);
  const resumeBuffer = resolveResumeBuffer(env);
  const lagEpsilon = resolveLagEpsilon(env);
  const lagRecheck = resolveLagRecheck(env);

  // 1. Fresh cache → return as-is (no endpoint re-fetch within TTL).
  const cached = await readCache({ readFileImpl, cachePath, ttlMs: cacheTtlMs, now });
  if (cached) return { ...cached, source: "cache" };

  const evalOpts = { threshold, resumeBuffer, lagEpsilon, lagRecheck, now };

  // Cache-bypass (#133): a suspected reflection lag is a transient, likely-stale
  // 100% reading. Persisting it would pin the false signal for the cache TTL and
  // re-serve it on the next check, defeating the short recheck. So when the
  // result flags a lag we skip the cache write — the next check hits the live
  // endpoint and can observe the post-lag value immediately.
  const maybeCache = async (result) => {
    if (result.suspected_reflection_lag) return result; // do NOT cache a lagged read
    await writeCache(result, { writeFileImpl, mkdirImpl, cachePath, now });
    return result;
  };

  // 2. Endpoint.
  try {
    const token = await readAccessToken({ readFileImpl, credentialsPath, now });
    if (!token) throw new Error("no usable OAuth access token");
    const windows = await fetchEndpointUsage(token, { fetchImpl });
    return await maybeCache({ ...evaluate(windows, evalOpts), source: "endpoint" });
  } catch (endpointErr) {
    // 3. JSONL fallback.
    try {
      const windows = await aggregateJsonlUsage({ readdirImpl, readFileImpl, projectsDir, now });
      return await maybeCache({ ...evaluate(windows, evalOpts), source: "jsonl" });
    } catch (jsonlErr) {
      // 4. Both failed → fail-open + warn (guard never hard-stops on its bug).
      warn(
        `usage-guard: signal unavailable (endpoint: ${endpointErr.message}; jsonl: ${jsonlErr.message}); failing open`,
      );
      return {
        five_hour: { utilization: 0, resets_at: null },
        seven_day: { utilization: 0, resets_at: null },
        ok: true,
        wait_seconds: 0,
        resets_at: null,
        resume_buffer_seconds: resumeBuffer,
        suspected_reflection_lag: false,
        source: "fail-open",
      };
    }
  }
}

// CLI entry: print the usage JSON to stdout. Exit 0 always (fail-open ethos);
// the JSON's `ok` field is the signal, not the exit code.
async function main() {
  // getUsage now defaults writeFileImpl/mkdirImpl to the real fs (symmetric with
  // readFileImpl), so the CLI no longer needs to inject them explicitly — every
  // caller that omits fs (including the PreToolUse hook) self-sustains the cache.
  const result = await getUsage();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

// Only run main() when executed directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`usage-guard: fatal ${err.message}; failing open\n`);
    process.stdout.write(
      `${JSON.stringify({
        five_hour: { utilization: 0, resets_at: null },
        seven_day: { utilization: 0, resets_at: null },
        ok: true,
        wait_seconds: 0,
        resets_at: null,
        resume_buffer_seconds: resolveResumeBuffer(),
        suspected_reflection_lag: false,
        source: "fail-open",
      })}\n`,
    );
  });
}
