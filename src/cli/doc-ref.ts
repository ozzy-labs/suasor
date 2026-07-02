/**
 * Resolve a repository doc path to a URL a user can actually open.
 *
 * The CLI prints doc pointers in next-steps / hints (e.g. `init`, `onboard`,
 * `doctor`, the standalone-binary gate). Bare `docs/guide/*.md` paths only
 * resolve for a *source checkout*: the npm package, the standalone binary, and
 * the Docker image ship `dist` + `docs/skills` but not `docs/guide` (ADR-0010,
 * `package.json` `files`). This turns a repo-relative doc path into an absolute
 * GitHub blob URL so the pointer is followable from any install channel.
 *
 * Pure and dependency-free (import-clean) so it can be pulled into any command
 * without touching cold start (NFR-PRF-1).
 *
 * Pinned to the `main` branch rather than a release tag; version-following tags
 * are a possible follow-up (Issue #386).
 */

/** GitHub blob base for repository docs on the default branch (see {@link docsUrl}). */
export const DOCS_BASE_URL = "https://github.com/ozzy-labs/suasor/blob/main/docs";

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
