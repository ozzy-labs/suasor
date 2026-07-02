/**
 * One-line "embedding disabled" hint for the retrieval-facing CLI commands
 * (`search` / `brief`), Issue #159.
 *
 * `suasor doctor` already reports a disabled embedding backend, but only when
 * the operator thinks to run it. At the moment they actually search — `suasor
 * search` / `suasor brief` — semantic recall is silently off and retrieval is
 * FTS-only, so a weak result set has no visible explanation. This emits a single
 * stderr line pointing at the embedding guide.
 *
 * Discipline (mirrors `progress.ts`): the hint goes to **stderr only** so stdout
 * (the result body and `--json`) stays pipe-clean, and it is suppressed when the
 * caller asked for machine-readable / quiet output (`--json` / `--no-progress`).
 */
import { docsUrl } from "./doc-ref.ts";

/** The subset of a writable stream this needs (stderr-shaped). */
export interface HintStream {
  write(s: string): boolean;
}

const HINT = `note: embedding disabled — searching with FTS only (${docsUrl("guide/embedding.md")})\n`;

/**
 * Write the embedding-disabled hint to `stderr` when `backend` is `"disabled"`.
 *
 * No-op when the backend is active, or when `quiet` is `true` (the caller passes
 * `--json` / `--no-progress` so stdout and captured output stay clean).
 */
export function emitEmbeddingDisabledHint(
  stderr: HintStream,
  backend: string,
  quiet: boolean,
): void {
  if (quiet || backend !== "disabled") return;
  stderr.write(HINT);
}
