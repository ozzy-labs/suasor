import pkg from "../package.json" with { type: "json" };

/**
 * Single source of truth for the Suasor version string: re-exported from
 * `package.json` so the CLI `--version`, the MCP server, etc. can never drift
 * from the published version. The build (`bun build` / `--compile`) inlines the
 * JSON, and release-please bumps `package.json` — so this stays correct without
 * a separate manual bump.
 */
export const VERSION: string = pkg.version;
