/**
 * `draft.export` — write a draft to a local file (ADR-0025).
 *
 * Suasor's only file-writing write tool: it persists a draft (reply / handoff /
 * announcement / plan text the host produced) as a file **inside the export
 * sandbox** (`[export].dir`). It never sends anything and never writes back to a
 * connector source (local-first / no-egress, ADR-0003 §2/§3 / ADR-0007). HITL.
 *
 * Guards (ADR-0025 §3/§4):
 *  - `filename` is a basename confined to the export dir (no `/`, `\`, `..`, abs).
 *  - the export dir must not sit inside a `[connectors.local].roots` entry, or
 *    exported drafts would be re-ingested (feedback loop, ADR-0023).
 *  - collisions get a numeric suffix (`name.md` → `name-1.md`) — non-destructive.
 *
 * Order: write the file, then append a body-less `DraftExported` audit event
 * (content-minimization: the body lives only in the file). A write failure
 * throws before any event, so the log never claims an export that did not happen.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join, resolve, sep } from "node:path";
import type { Store } from "../db/index.ts";

export interface DraftExportInput {
  /** Draft text to write. */
  content: string;
  /** Target filename (basename only; an extension is added if missing). */
  filename: string;
  /** Export format. */
  format: "md" | "txt";
  /** Source the draft derives from, for provenance (optional). */
  sourceExternalId?: string;
}

export interface DraftExportDeps {
  /** Resolved absolute export sandbox dir (`config.export.dir`). */
  exportDir: string;
  /** `[connectors.local].roots` — the export dir must not nest under any. */
  localRoots?: string[];
}

export interface DraftExportOutput {
  /** Absolute path written. */
  path: string;
  status: "exported";
}

/** Raised on an invalid filename or an export dir that overlaps a local root. */
export class DraftExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DraftExportError";
  }
}

/** True when `dir` is equal to or nested under `root` (both resolved absolute). */
function isInside(dir: string, root: string): boolean {
  const d = resolve(dir);
  const r = resolve(root);
  return d === r || d.startsWith(r + sep);
}

/**
 * Write a draft into the export sandbox and append `DraftExported`. The host
 * gates this behind human approval (HITL). Throws `DraftExportError` on a bad
 * filename or a sandbox that overlaps a local connector root.
 */
export function draftExport(
  store: Store,
  input: DraftExportInput,
  deps: DraftExportDeps,
  now: Date = new Date(),
): DraftExportOutput {
  const { content, filename, format, sourceExternalId } = input;

  // Filename must be a plain basename — reject path separators / traversal / abs.
  if (
    filename.length === 0 ||
    filename === "." ||
    filename === ".." ||
    filename.includes("/") ||
    filename.includes("\\") ||
    isAbsolute(filename)
  ) {
    throw new DraftExportError(`invalid filename (basename only): ${filename}`);
  }

  // The export dir must not be inside a local connector root (re-ingest loop).
  for (const root of deps.localRoots ?? []) {
    if (isInside(deps.exportDir, root)) {
      throw new DraftExportError(
        `export dir ${deps.exportDir} is inside local connector root ${root} (would re-ingest)`,
      );
    }
  }

  // Ensure the filename carries the format extension.
  const name =
    extname(filename).toLowerCase() === `.${format}` ? filename : `${filename}.${format}`;

  mkdirSync(deps.exportDir, { recursive: true });

  // Non-destructive: suffix on collision (name.md → name-1.md → name-2.md …).
  const base = name.slice(0, name.length - `.${format}`.length);
  let target = join(deps.exportDir, name);
  for (let i = 1; existsSync(target); i += 1) {
    target = join(deps.exportDir, `${base}-${i}.${format}`);
  }

  // Write first; only on success record the body-less audit event (ADR-0025 §5).
  writeFileSync(target, content, "utf8");
  store.record(
    {
      type: "DraftExported",
      path: target,
      format,
      ...(sourceExternalId !== undefined ? { sourceExternalId } : {}),
    },
    now,
  );

  return { path: target, status: "exported" };
}
