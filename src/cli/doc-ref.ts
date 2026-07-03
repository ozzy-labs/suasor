/**
 * Doc-pointer resolution used by the CLI's next-steps / hints (`init`,
 * `onboard`, `doctor`, the standalone-binary gate).
 *
 * The implementation moved to `src/shared/doc-ref.ts` so lower layers
 * (config / retrieval / MCP) can reuse it without a dependency inversion onto
 * the CLI (Issue #396). This module re-exports it to keep existing CLI imports
 * (`./doc-ref.ts`) and their tests stable.
 */
export { DOCS_BASE_URL, docsUrl } from "../shared/doc-ref.ts";
