#!/usr/bin/env bun
/**
 * Coverage gate (#258). Runs `bun test --coverage` and enforces an *overall*
 * line/function coverage floor parsed from the text reporter's "All files" row.
 *
 * Why a script instead of Bun's native `coverageThreshold`: on Bun 1.2.23 the
 * native gate cannot express an overall floor for this repo (verified) —
 *   - the per-metric object/sub-table form is parsed but silently NOT enforced;
 *   - the scalar form is enforced PER FILE, so wiring/entrypoint files with ~0%
 *     function coverage (src/index.ts, src/cli/commands/mcp-serve.ts) fail any
 *     meaningful global value;
 *   - the lcov reporter's line counts disagree with the text reporter.
 * See bunfig.toml for the full note.
 *
 * The thresholds are set a couple of points below the measured floor (line ~94%,
 * function ~90% on integrated main) so routine churn does not break the gate;
 * ratchet them upward as coverage rises (#258 → #265). Override per-run with env
 * vars COVERAGE_MIN_LINE / COVERAGE_MIN_FUNCTION (percent, e.g. 95).
 *
 * The coverage table is emitted by Bun on STDERR; this script captures it,
 * streams the full output through so CI logs are unchanged, propagates a real
 * test failure verbatim, then enforces the floor.
 */
import { spawnSync } from "node:child_process";

const MIN_LINE = Number(process.env.COVERAGE_MIN_LINE ?? "92");
const MIN_FUNCTION = Number(process.env.COVERAGE_MIN_FUNCTION ?? "88");

const run = spawnSync("bun", ["test", "--coverage"], { encoding: "utf8" });

// Stream Bun's output through unchanged (results + coverage table on stderr).
if (run.stdout) process.stdout.write(run.stdout);
if (run.stderr) process.stderr.write(run.stderr);

if (run.error) {
  console.error(`✖ coverage-gate: failed to spawn bun test: ${run.error.message}`);
  process.exit(1);
}

// A real test failure (non-zero exit) takes precedence over the coverage floor.
if (run.status !== 0) {
  console.error(`✖ coverage-gate: \`bun test\` failed (exit ${run.status}); see output above.`);
  process.exit(run.status ?? 1);
}

// Parse the "All files" summary row: "All files | <% Funcs> | <% Lines> |".
const combined = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
const match = combined.match(/^All files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|/m);
if (!match) {
  console.error(
    "✖ coverage-gate: could not find the 'All files' coverage summary row. " +
      "Did the text reporter format change? Run `bun test --coverage` locally.",
  );
  process.exit(1);
}

const funcPct = Number.parseFloat(match[1]);
const linePct = Number.parseFloat(match[2]);

const failures = [];
if (linePct < MIN_LINE) failures.push(`line ${linePct.toFixed(2)}% < ${MIN_LINE}%`);
if (funcPct < MIN_FUNCTION) failures.push(`function ${funcPct.toFixed(2)}% < ${MIN_FUNCTION}%`);

if (failures.length > 0) {
  console.error(
    `\n✖ coverage-gate: below floor — ${failures.join(", ")}.\n` +
      `  Floor: line ≥ ${MIN_LINE}%, function ≥ ${MIN_FUNCTION}%. Add tests to cover the change.`,
  );
  process.exit(1);
}

console.error(
  `\n✓ coverage-gate: line ${linePct.toFixed(2)}% (≥ ${MIN_LINE}%), ` +
    `function ${funcPct.toFixed(2)}% (≥ ${MIN_FUNCTION}%).`,
);
