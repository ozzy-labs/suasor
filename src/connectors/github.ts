/**
 * GitHub connector (ADR-0007). Read-only ingest of issues + pull requests for
 * the configured repositories, plus the per-token **notification stream**
 * (mentions / review requests / etc.), into `SourceRecord`s.
 *
 * - **read-only** — only `GET` list endpoints are called; nothing is written
 *   back to GitHub (ADR-0003). The notification stream is read via
 *   `GET /notifications` — the thread list is fetched but never marked read.
 * - **delta** — two independent delta axes share one opaque cursor:
 *   - **issues/PRs** use the issues `since` cursor (records the most recent
 *     `updated_at` seen across repos).
 *   - **notifications** are a per-token personal stream (not repo-scoped), so
 *     they carry their **own** `since` cursor (most recent thread `updated_at`),
 *     decoupled from the repo allowlist (FR-ING-3). A single shared cursor would
 *     be a latent data-loss bug: a quiet axis would be raised to the busier
 *     axis's timestamp and silently skip its own newer items (mirrors the Slack
 *     per-channel cursor fix, ADR-0011).
 *   The cursor is serialized as a JSON `{ issues, notifications }` map. A bare
 *   string cursor from before notifications were added is read as the legacy
 *   `issues` floor (backward compatible).
 * - **identity** — `gh:<owner>/<repo>:issue:<number>` / `:pull_request:<number>`
 *   for repo items; `gh:notification:<thread-id>` for notifications
 *   (cross-source-unique; notifications are token-scoped, not repo-scoped, so
 *   they are *not* repo-prefixed — ADR-0007). `source_type` distinguishes the
 *   kinds (`github_issue` / `github_pull_request` / `github_notification`).
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
import { type IsolationResult, syncResourcesIsolated } from "./per-resource.ts";

/** `[connectors.github]` config (docs/design/config.md). */
export const GithubConnectorConfig = z.object({
  /** Repositories to ingest, as `"owner/repo"`. */
  repos: z.array(z.string().regex(/^[^/]+\/[^/]+$/, "expected 'owner/repo'")).default([]),
  /** Issue/PR states to ingest. */
  state: z.enum(["open", "closed", "all"]).default("all"),
  /**
   * Ingest the per-token notification stream (`GET /notifications`) as a demand
   * signal (mentions / review requests / etc.). This is a personal, per-token
   * stream independent of `repos` — when `all`, every notified repo is ingested;
   * when `repos`, the stream is filtered to the configured allowlist (Issue #93).
   * Defaults off so existing installs keep their issues/PR-only behaviour.
   */
  notifications: z.enum(["off", "all", "repos"]).default("off"),
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

/** Shape of the notification thread items we read (subset of the REST response). */
interface GithubNotificationItem {
  id: string;
  reason: string;
  updated_at: string;
  unread?: boolean;
  subject?: { title?: string; type?: string; url?: string | null } | null;
  repository?: { full_name?: string } | null;
}

/**
 * The github cursor carries two independent delta axes — repo issues/PRs and
 * the per-token notification stream — so neither raises the other's floor.
 */
interface GithubCursor {
  /** Most recent issue/PR `updated_at` seen (repo axis). */
  issues: string | null;
  /** Most recent notification thread `updated_at` seen (token axis). */
  notifications: string | null;
}

/**
 * Parse the opaque resume cursor. A JSON `{ issues, notifications }` object is
 * read as-is; a bare string (pre-notifications cursor) is read as the legacy
 * `issues` floor with no notifications floor.
 */
function parseCursor(raw: string | null): GithubCursor {
  if (!raw) return { issues: null, notifications: null };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      return {
        issues: typeof obj.issues === "string" ? obj.issues : null,
        notifications: typeof obj.notifications === "string" ? obj.notifications : null,
      };
    }
  } catch {
    // Not JSON → legacy bare-string `issues` floor.
  }
  return { issues: raw, notifications: null };
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

/** Build the `SourceRecord` for one notification thread (token-scoped). */
function toNotificationRecord(item: GithubNotificationItem): SourceRecord {
  const title = item.subject?.title ?? "(notification)";
  const repo = item.repository?.full_name ?? null;
  // Body is the subject title; repo + reason go to meta. The subject `url` is an
  // API url (not the html url) so it is kept in meta for provenance, not body.
  return {
    externalId: `gh:notification:${item.id}`,
    sourceType: "github_notification",
    body: title,
    observedAt: item.updated_at,
    meta: {
      repo,
      reason: item.reason,
      subjectType: item.subject?.type ?? null,
      subjectUrl: item.subject?.url ?? null,
      unread: item.unread ?? null,
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
      // Routes return heterogeneous item shapes; each caller narrows its page.
      data: unknown[];
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

  /** Highest issue/PR `updated_at` observed this run → next-run repo cursor. */
  private maxIssueUpdatedAt: string | null = null;
  /** Highest notification `updated_at` observed this run → next-run token cursor. */
  private maxNotificationUpdatedAt: string | null = null;
  /** Per-repo isolation outcome (set when `syncRepos` ran) → finalize summary. */
  private repoIsolation: IsolationResult | null = null;
  /**
   * Per-repo high-water marks observed this run, keyed by `owner/repo`. The repo
   * delta axis is a *single shared* `since` cursor (the most recent `updated_at`
   * across repos), so a repo that fails mid-fetch must not drag the shared floor
   * forward past its last good item and silently skip the repo's gap next run.
   * `finalize` derives the next shared cursor from only the repos that fully
   * succeeded, mirroring Slack's "failed sub-unit keeps its prior cursor".
   */
  private repoMaxUpdatedAt: Record<string, string> = {};

  constructor(
    private readonly config: GithubConnectorConfig,
    private readonly octokitFactory: OctokitFactory,
  ) {}

  async *sync(ctx: SyncContext): AsyncIterable<SourceRecord> {
    const wantsNotifications = this.config.notifications !== "off";
    // Nothing to do when there are no repos to scan and notifications are off.
    if (this.config.repos.length === 0 && !wantsNotifications) return;

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

    const cursor = parseCursor(ctx.cursor);
    this.maxIssueUpdatedAt = cursor.issues;
    this.maxNotificationUpdatedAt = cursor.notifications;
    this.repoIsolation = null;
    this.repoMaxUpdatedAt = {};

    yield* this.syncRepos(octokit, cursor.issues, ctx);
    if (wantsNotifications) {
      yield* this.syncNotifications(octokit, cursor.notifications);
    }
  }

  /**
   * Stream issues/PRs for every configured repo (repo delta axis) with
   * per-repo error isolation (ADR-0014 generalized, Issue #193): one repo's
   * failure (e.g. a `403`) records a warn and skips that repo, the rest keep
   * streaming, and only an all-repos failure throws. A failed repo's items do
   * not advance the shared `since` cursor (cursor preserved), so its gap is not
   * silently skipped next run.
   */
  private async *syncRepos(
    octokit: OctokitLike,
    since: string | null,
    ctx: SyncContext,
  ): AsyncIterable<SourceRecord> {
    const fetchRepo = (repo: string): AsyncIterable<SourceRecord> => {
      const self = this;
      return (async function* () {
        const [owner, name] = repo.split("/");
        const params: Record<string, unknown> = {
          owner,
          repo: name,
          state: self.config.state,
          per_page: 100,
          sort: "updated",
          direction: "asc",
        };
        // `since` is the issues delta cursor: only items updated at/after it.
        if (since) params.since = since;

        for await (const page of octokit.paginate.iterator(
          "GET /repos/{owner}/{repo}/issues",
          params,
        )) {
          for (const item of page.data as GithubIssueItem[]) {
            // Track this repo's own high-water mark; the shared `since` cursor
            // is derived in `finalize` from only the repos that fully succeeded
            // so a mid-fetch failure never advances the floor past its gap.
            const seen = self.repoMaxUpdatedAt[repo];
            if (seen === undefined || item.updated_at > seen) {
              self.repoMaxUpdatedAt[repo] = item.updated_at;
            }
            yield toRecord(repo, item);
          }
        }
      })();
    };

    yield* syncResourcesIsolated(
      this.config.repos,
      ctx,
      (repo) => repo,
      "repo",
      fetchRepo,
      (result) => {
        this.repoIsolation = result;
        // Derive the next shared `since` cursor from only the repos that fully
        // succeeded (a failed repo keeps its prior cursor — its items are
        // dropped from the floor so its gap is re-scanned next run).
        const failed = new Set(result.failures.map((f) => f.resource));
        for (const [repo, ts] of Object.entries(this.repoMaxUpdatedAt)) {
          if (failed.has(repo)) continue;
          if (this.maxIssueUpdatedAt === null || ts > this.maxIssueUpdatedAt) {
            this.maxIssueUpdatedAt = ts;
          }
        }
      },
    );
  }

  /**
   * Stream the per-token notification thread list (token delta axis). When the
   * mode is `repos`, the stream is filtered to the configured allowlist; `all`
   * ingests every notified repo. The repo allowlist set is matched against each
   * thread's `repository.full_name` (case-insensitive).
   */
  private async *syncNotifications(
    octokit: OctokitLike,
    since: string | null,
  ): AsyncIterable<SourceRecord> {
    const allow =
      this.config.notifications === "repos"
        ? new Set(this.config.repos.map((r) => r.toLowerCase()))
        : null;

    const params: Record<string, unknown> = {
      all: true,
      per_page: 100,
    };
    // `since` is the notifications delta cursor (its own axis, not the repo one).
    if (since) params.since = since;

    for await (const page of octokit.paginate.iterator("GET /notifications", params)) {
      for (const item of page.data as GithubNotificationItem[]) {
        // Advance the cursor over every thread the API returned (even filtered
        // ones) so a filtered-out repo never re-floods the stream next run.
        if (
          this.maxNotificationUpdatedAt === null ||
          item.updated_at > this.maxNotificationUpdatedAt
        ) {
          this.maxNotificationUpdatedAt = item.updated_at;
        }
        if (allow) {
          const full = item.repository?.full_name?.toLowerCase();
          if (!full || !allow.has(full)) continue;
        }
        yield toNotificationRecord(item);
      }
    }
  }

  finalize(): SyncResult {
    const cursor: GithubCursor = {
      issues: this.maxIssueUpdatedAt,
      notifications: this.maxNotificationUpdatedAt,
    };
    // A partial repo failure (some repos failed, some succeeded) is surfaced so
    // the CLI exits non-zero without discarding the collected records (ADR-0027,
    // Issue #193). A `summaryLines` entry names each repo's outcome.
    const iso = this.repoIsolation;
    const extra = iso?.partialFailure
      ? {
          partialFailure: true,
          ...(iso.summaryLines ? { summaryLines: iso.summaryLines } : {}),
        }
      : {};
    // Persist nothing when both axes are empty (first run, no items).
    if (cursor.issues === null && cursor.notifications === null) {
      return { cursor: null, ...extra };
    }
    return { cursor: JSON.stringify(cursor), ...extra };
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
