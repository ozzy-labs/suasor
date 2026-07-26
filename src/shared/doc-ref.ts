/**
 * Resolve a repository doc path to a URL a user can actually open.
 *
 * Doc pointers surface across the stack — the CLI prints them in next-steps /
 * hints (`init`, `onboard`, `doctor`, the standalone-binary gate), and the
 * config / retrieval / MCP layers embed them in warnings, findings, and tool
 * responses. Bare `docs/guide/*.md` paths only resolve for a *source checkout*:
 * the npm package, the standalone binary, and the Docker image ship `dist` +
 * `docs/skills` but not `docs/guide` (ADR-0010, `package.json` `files`). This
 * turns a repo-relative doc path into an absolute GitHub blob URL so the pointer
 * is followable from any install channel.
 *
 * Lives in `src/shared` (not `src/cli`) so lower layers can import it without a
 * dependency inversion onto the CLI. Pure and dependency-free (import-clean) so
 * it can be pulled into any module without touching cold start (NFR-PRF-1).
 *
 * Pinned to the `main` branch rather than a release tag; version-following tags
 * are a possible follow-up (Issue #386).
 */

/**
 * GitHub blob base for the repository tree on the default branch.
 *
 * Exported alongside {@link DOCS_BASE_URL} because the same prefix is what makes
 * an absolute link *checkable*: `scripts/check-doc-links.mjs` strips it to
 * recover a repository path and resolves the target like any relative link, so a
 * URL written into the bundled skills (ADR-0008 — they ship without the rest of
 * `docs/`, so they cannot use relative links) still fails the lint when the doc
 * it points at is renamed. One constant, so the writer and the checker cannot
 * disagree about what "our own repository" spells.
 */
export const REPO_BLOB_BASE_URL = "https://github.com/ozzy-labs/suasor/blob/main";

/** GitHub blob base for repository docs on the default branch (see {@link docsUrl}). */
export const DOCS_BASE_URL = `${REPO_BLOB_BASE_URL}/docs`;

/**
 * Build a followable URL for a repository doc.
 *
 * @param path doc path relative to the repository `docs/` directory, with an
 *   optional `#anchor`, e.g. `"guide/connectors.md"` or
 *   `"guide/install.md#binary-scope"`.
 * @returns the absolute GitHub blob URL, e.g.
 *   `https://github.com/ozzy-labs/suasor/blob/main/docs/guide/connectors.md`.
 */
export function docsUrl(path: string): string {
  return `${DOCS_BASE_URL}/${path.replace(/^\/+/, "")}`;
}
