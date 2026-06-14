/**
 * GitHub connector (ADR-0007). Read-only ingest of issues + pull requests for
 * the configured repositories into `SourceRecord`s.
 *
 * - **read-only** — only `GET` list endpoints are called; nothing is written
 *   back to GitHub (ADR-0003).
 * - **delta** — uses the issues `since` cursor (a delta API): records the most
 *   recent `updated_at` seen and returns it as the next cursor so subsequent
 *   syncs fetch only changed items (FR-ING-3). Body content also carries a
 *   fingerprint, so the sync service still skips unchanged bodies.
 * - **identity** — `gh:<owner>/<repo>:issue:<number>` (cross-source-unique,
 *   repo-prefixed, ADR-0007). PRs are issues in the REST API; `source_type`
 *   distinguishes them (`github_issue` / `github_pull_request`).
 * - **import-clean** — `octokit` is **lazy-imported inside `sync`**, so building
 *   the connector / registry never pulls the SDK (ADR-0007, NFR-PRF-1). This
 *   module's top-level imports are limited to `zod` + the contract types.
 * - **secrets** — the token comes from `ctx.secret("token")` (keychain + env
 *   override, NFR-PRV-4); it is never read from config.
 */
import { z } from "zod";
import type {
  Connector,
  ConnectorConfig,
  SourceRecord,
  SyncContext,
  SyncResult,
} from "./contract.ts";

/** `[connectors.github]` config (docs/design/config.md). */
export const GithubConnectorConfig = z.object({
  /** Repositories to ingest, as `"owner/repo"`. */
  repos: z.array(z.string().regex(/^[^/]+\/[^/]+$/, "expected 'owner/repo'")).default([]),
  /** Issue/PR states to ingest. */
  state: z.enum(["open", "closed", "all"]).default("all"),
  /** GitHub API base URL (override for GitHub Enterprise). */
  baseUrl: z.string().url().optional(),
});
export type GithubConnectorConfig = z.infer<typeof GithubConnectorConfig>;

export const GITHUB_CONNECTOR_NAME = "github";

/** Shape of the issue list items we read (subset of the REST response). */
interface GithubIssueItem {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  updated_at: string;
  pull_request?: unknown;
  user?: { login?: string } | null;
}

/** Build the `SourceRecord` for one issue/PR of a repo. */
function toRecord(repo: string, item: GithubIssueItem): SourceRecord {
  const isPr = item.pull_request !== undefined;
  const kind = isPr ? "pull_request" : "issue";
  // Body = title + body so the FTS index covers the subject line too.
  const body = item.body ? `${item.title}\n\n${item.body}` : item.title;
  return {
    externalId: `gh:${repo}:${kind}:${item.number}`,
    sourceType: isPr ? "github_pull_request" : "github_issue",
    body,
    observedAt: item.updated_at,
    meta: {
      repo,
      number: item.number,
      state: item.state,
      url: item.html_url,
      author: item.user?.login ?? null,
    },
  };
}

/**
 * The GitHub `Octokit` client surface we depend on. Declared structurally so
 * tests can inject a fake without importing the SDK, and so the real client is
 * lazy-loaded.
 */
export interface OctokitLike {
  paginate: {
    iterator: (
      route: string,
      params: Record<string, unknown>,
    ) => AsyncIterable<{
      data: GithubIssueItem[];
    }>;
  };
}

/** How the connector obtains an Octokit client (overridable in tests). */
export type OctokitFactory = (options: {
  auth: string;
  baseUrl?: string;
}) => Promise<OctokitLike> | OctokitLike;

/** Default factory: lazy-imports `octokit` so registration stays import-clean. */
const defaultOctokitFactory: OctokitFactory = async ({ auth, baseUrl }) => {
  const { Octokit } = await import("octokit");
  return new Octokit({ auth, ...(baseUrl ? { baseUrl } : {}) }) as unknown as OctokitLike;
};

export interface GithubConnectorOptions {
  /** Octokit factory override (tests inject a fake; default lazy-imports octokit). */
  octokitFactory?: OctokitFactory;
}

/** GitHub connector implementing the read-only contract (ADR-0007). */
class GithubConnector implements Connector {
  readonly name = GITHUB_CONNECTOR_NAME;
  readonly sourceType = "github";

  /** Highest `updated_at` observed this run → next-run `since` cursor. */
  private maxUpdatedAt: string | null = null;

  constructor(
    private readonly config: GithubConnectorConfig,
    private readonly octokitFactory: OctokitFactory,
  ) {}

  async *sync(ctx: SyncContext): AsyncIterable<SourceRecord> {
    if (this.config.repos.length === 0) return;

    const token = await ctx.secret("token");
    if (!token) {
      throw new Error(
        "github connector: no token configured " +
          "(set SUASOR_CONNECTOR_GITHUB_TOKEN or store it in the OS keychain)",
      );
    }

    const octokit = await this.octokitFactory({
      auth: token,
      ...(this.config.baseUrl ? { baseUrl: this.config.baseUrl } : {}),
    });

    this.maxUpdatedAt = ctx.cursor;

    for (const repo of this.config.repos) {
      const [owner, name] = repo.split("/");
      const params: Record<string, unknown> = {
        owner,
        repo: name,
        state: this.config.state,
        per_page: 100,
        sort: "updated",
        direction: "asc",
      };
      // `since` is the issues delta cursor: only items updated at/after it.
      if (ctx.cursor) params.since = ctx.cursor;

      for await (const page of octokit.paginate.iterator(
        "GET /repos/{owner}/{repo}/issues",
        params,
      )) {
        for (const item of page.data) {
          if (this.maxUpdatedAt === null || item.updated_at > this.maxUpdatedAt) {
            this.maxUpdatedAt = item.updated_at;
          }
          yield toRecord(repo, item);
        }
      }
    }
  }

  finalize(): SyncResult {
    return { cursor: this.maxUpdatedAt };
  }
}

/**
 * Build the GitHub connector from its config slice (validates with Zod).
 * `octokit` is not imported here — only when `sync` actually runs.
 */
export function createGithubConnector(
  config: ConnectorConfig,
  options: GithubConnectorOptions = {},
): Connector {
  const parsed = GithubConnectorConfig.parse(config ?? {});
  return new GithubConnector(parsed, options.octokitFactory ?? defaultOctokitFactory);
}
