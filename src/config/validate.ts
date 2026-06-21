/**
 * Config validation + safe auto-fix (Issue #280).
 *
 * `doctor` answers "is the environment wired?"; this module answers "is the
 * config file itself well-formed?" — the deeper structural check the Issue calls
 * for. It re-runs the same Zod validation the loader uses (schema.ts +
 * per-connector strict slices, ADR-0007) but, instead of failing fast with a
 * single `ConfigError`, it collects every finding, classifies it, and (with
 * `--fix`) applies the conservative subset of repairs that are unambiguously
 * safe.
 *
 * Findings are classified into the categories the Issue enumerates:
 *  - `missing-required` — a required key is absent.
 *  - `invalid-value`    — a present value violates its type / enum / range /
 *                         regex constraint (an invalid regex literal in a
 *                         pattern-typed field also lands here via Zod).
 *  - `unknown-key`      — a key not in the (strict) connector slice schema; the
 *                         classic `repo` vs `repos` typo. Safe to drop.
 *  - `dangling-reference` — a path-valued setting points at something that does
 *                         not exist (a `[connectors.local].roots` entry, or
 *                         `[storage].dbPath`'s parent directory).
 *
 * Safe-fix policy (intentionally narrow — never guesses a value):
 *  - drop `unknown-key` findings (typos that strict validation already rejects),
 *  - drop `dangling-reference` `roots` entries (a non-existent local root only
 *    warns + skips at sync time, so removing it changes nothing but the noise).
 * `missing-required` / `invalid-value` are NEVER auto-fixed (we will not invent
 * a value), and `[storage].dbPath` is never dropped (it may be created later).
 *
 * Pure with respect to the filesystem here: the validators read the config tree
 * and probe paths but write nothing. The CLI command owns reading/writing
 * `config.toml`; this module just computes the findings and the repaired tree.
 */
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { loadConnectorConfigSchema } from "../connectors/registry.ts";
import { Config } from "./schema.ts";

/** Classification of a single validation finding. */
export type FindingKind =
  | "missing-required"
  | "invalid-value"
  | "unknown-key"
  | "dangling-reference";

/** One validation finding against the config tree. */
export interface Finding {
  /** Dotted path to the offending key (e.g. `connectors.github.repos`). */
  path: string;
  /** Category of the problem. */
  kind: FindingKind;
  /** Human-readable explanation. */
  message: string;
  /** Whether `--fix` can safely repair this finding. */
  fixable: boolean;
  /**
   * For a fixable array-element removal (a dangling local root), the exact string
   * value to remove — carried structurally so the CLI `--fix` does not have to
   * re-parse it out of `message` (brittle for values containing `: `).
   */
  value?: string;
}

/** Result of validating (and optionally fixing) a config tree. */
export interface ValidateResult {
  /** Every finding, in a stable order (root schema first, then connectors). */
  findings: Finding[];
  /** The repaired config tree when fixes were applied, else the input unchanged. */
  fixed: Record<string, unknown>;
  /** Paths actually repaired (subset of `findings`); empty when `applyFix` is false. */
  applied: string[];
}

/** Same universal control key the loader recognizes on every connector slice. */
const COMMON_CONNECTOR_KEYS = z.object({ enabled: z.boolean().optional() });

/** Map a Zod issue code to one of our finding categories. */
function classifyZodIssue(issue: z.core.$ZodIssue): FindingKind {
  // A missing required key surfaces as an "invalid_type" with `received` undefined.
  if (issue.code === "invalid_type" && "received" in issue && issue.received === "undefined") {
    return "missing-required";
  }
  // Unrecognized keys (strict mode) are typos / unknown keys.
  if (issue.code === "unrecognized_keys") return "unknown-key";
  // Everything else — enum mismatch, regex (invalid_string), range, wrong type —
  // is an invalid value.
  return "invalid-value";
}

/** Render a Zod issue path as a dotted string, optionally under a prefix. */
function dottedPath(issuePath: ReadonlyArray<PropertyKey>, prefix = ""): string {
  const tail = issuePath.map((p) => String(p)).join(".");
  if (prefix && tail) return `${prefix}.${tail}`;
  return prefix || tail || "(root)";
}

/** Deep clone a plain JSON-ish config tree (no class instances live here). */
function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Delete a key by single-segment name from an object, returning whether it existed. */
function deleteKey(obj: Record<string, unknown>, key: string): boolean {
  if (Object.hasOwn(obj, key)) {
    delete obj[key];
    return true;
  }
  return false;
}

/**
 * Validate a parsed config tree (the raw merged layer, before defaults) and
 * compute findings. When `applyFix` is true, also returns a repaired tree with
 * the safe subset removed.
 *
 * @param raw      the parsed `config.toml` object (untyped layer).
 * @param applyFix apply the safe-fix policy and return the repaired tree.
 * @param pathExists injectable existence probe (defaults to fs) for the
 *   `storage.dbPath` parent-dir check; lets tests run it deterministically.
 *   (Local-root existence is checked by the connector schema against the real
 *   FS, so it is not governed by this probe.)
 */
export async function validateConfig(
  raw: Record<string, unknown>,
  applyFix = false,
  pathExists: (p: string) => boolean = existsSync,
): Promise<ValidateResult> {
  const findings: Finding[] = [];
  const fixed = clone(raw);
  const applied: string[] = [];

  // 1. Root schema validation (storage / embedding / llm / extraction / export).
  //    The root `connectors` is an open record, so connector slices are checked
  //    separately below with their strict per-connector schemas.
  const rootResult = Config.safeParse(raw);
  if (!rootResult.success) {
    for (const issue of rootResult.error.issues) {
      // Skip anything under `connectors` — handled by the strict slice pass so a
      // typo'd connector key is reported as `unknown-key`, not a generic error.
      if (issue.path[0] === "connectors") continue;
      findings.push({
        path: dottedPath(issue.path),
        kind: classifyZodIssue(issue),
        message: issue.message,
        fixable: false, // root-schema issues are never auto-fixed (no value invention).
      });
    }
  }

  // 2. Per-connector slice validation (strict — unknown keys rejected, ADR-0007).
  const connectors = isRecord(raw.connectors) ? raw.connectors : {};
  // Dangling local-root indices to drop in one pass after the loop (filtering by
  // index inside the loop would shift later indices and corrupt the removal).
  const danglingLocalRoots: number[] = [];
  for (const [name, sliceRaw] of Object.entries(connectors)) {
    const slice = isRecord(sliceRaw) ? sliceRaw : {};
    const schema = await loadConnectorConfigSchema(name);
    if (!schema) continue; // unknown / schema-less connector stays lenient.
    const validator =
      schema instanceof z.ZodObject ? schema.extend(COMMON_CONNECTOR_KEYS.shape).strict() : schema;
    const result = validator.safeParse(slice);
    if (result.success) continue;
    for (const issue of result.error.issues) {
      const kind = classifyZodIssue(issue);
      if (kind === "unknown-key" && issue.code === "unrecognized_keys") {
        // One finding per unknown key so each typo is individually fixable.
        for (const key of issue.keys) {
          const path = `connectors.${name}.${key}`;
          findings.push({
            path,
            kind: "unknown-key",
            message: `unknown key '${key}' (typo? not part of the ${name} connector schema)`,
            fixable: true,
          });
          if (applyFix) {
            const sliceFixed = (fixed.connectors as Record<string, Record<string, unknown>>)?.[
              name
            ];
            if (isRecord(sliceFixed) && deleteKey(sliceFixed, key)) applied.push(path);
          }
        }
        continue;
      }
      // The local connector's slice schema (LocalConnectorConfigSchema) checks
      // that each `roots` entry exists and is a readable directory, surfacing a
      // non-existent root as a custom (invalid-value) issue on `roots.<n>`. That
      // is a *dangling reference*, and a missing root only warns+skips at sync
      // time — so reclassify it and make it the one path `--fix` can drop.
      if (name === "local" && issue.path[0] === "roots" && issue.path.length === 2) {
        const index = Number(issue.path[1]);
        const root = Array.isArray(slice.roots) ? slice.roots[index] : undefined;
        const path = `connectors.local.roots.${index}`;
        findings.push({
          path,
          kind: "dangling-reference",
          message: `local root does not exist or is not a directory: ${String(root)}`,
          fixable: true,
          ...(typeof root === "string" ? { value: root } : {}),
        });
        if (applyFix) {
          danglingLocalRoots.push(index);
          applied.push(path);
        }
        continue;
      }
      findings.push({
        path: dottedPath(issue.path, `connectors.${name}`),
        kind,
        message: issue.message,
        fixable: false,
      });
    }
  }
  // Drop all dangling local roots in one pass (indices into the original array).
  if (applyFix && danglingLocalRoots.length > 0) {
    const localFixed = (fixed.connectors as Record<string, Record<string, unknown>>)?.local;
    if (isRecord(localFixed) && Array.isArray(localFixed.roots)) {
      const drop = new Set(danglingLocalRoots);
      localFixed.roots = localFixed.roots.filter((_, i) => !drop.has(i));
    }
  }

  // 3. Dangling-reference checks (path-valued settings that point at nothing).
  //    [storage].dbPath: its parent directory must exist (the file itself may be
  //    created by `init`, so only the dir is a dangling reference). Reported but
  //    NOT auto-fixed (the value is meaningful even when the dir is absent).
  const storage = isRecord(raw.storage) ? raw.storage : undefined;
  const dbPath = typeof storage?.dbPath === "string" ? storage.dbPath : undefined;
  if (dbPath !== undefined && !pathExists(dirname(dbPath))) {
    findings.push({
      path: "storage.dbPath",
      kind: "dangling-reference",
      message: `parent directory does not exist: ${dirname(dbPath)} (run \`suasor init\`)`,
      fixable: false,
    });
  }

  //    (local [connectors.local].roots existence is checked inside the connector
  //    slice pass above, where LocalConnectorConfigSchema already probes each
  //    root — see the reclassification there.)

  return { findings, fixed, applied };
}

/**
 * Guard `[embedding].dim` against the dimension an existing DB's vec0 table was
 * created with (Issue #294). The vec0 width is fixed at DB creation; changing
 * `dim` in config afterwards does NOT resize it, so a mismatch makes every vector
 * insert fail and recall silently degrades to empty. Unlike `doctor`'s probe
 * (which embeds a string to check the *model* output), this is a pure local DB
 * read — no embedding backend, no egress — so it works even when the backend is
 * disabled or no API key is set.
 *
 * @param configDim the resolved `[embedding].dim` (after defaults).
 * @param dbDim     the vec0 table's dimension, or `null` when the table is absent
 *   (a fresh / FTS-only store — nothing to mismatch against).
 * @returns a single `invalid-value` finding on `embedding.dim` when the two
 *   disagree, else an empty array. Never auto-fixed (the remedy is a fresh DB /
 *   re-sync, not a config rewrite — HITL, ADR-0004).
 */
export function checkEmbeddingDim(configDim: number, dbDim: number | null): Finding[] {
  if (dbDim === null || dbDim === configDim) return [];
  return [
    {
      path: "embedding.dim",
      kind: "invalid-value",
      message:
        `[embedding].dim is ${configDim} but the existing DB's vec0 table is ${dbDim}-dim; ` +
        "vector inserts fail and recall degrades to empty. Either set [embedding].dim = " +
        `${dbDim} to match the store, or start a fresh DB / delete + rebuild + re-sync ` +
        "to adopt the new dimension. See docs/guide/embedding.md.",
      fixable: false,
    },
  ];
}

/** Narrow an unknown to a plain object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
