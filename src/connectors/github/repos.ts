/**
 * GitHub repository discovery for `github repos` (ADR-0030; the github port of
 * Slack's `slack conversations` discovery, ADR-0011).
 *
 * Enumerates the repositories a token can see (`GET /user/repos`) so the operator
 * can discover `owner/repo` full names without hand-hunting them from the Web UI
 * — closing the typo→silent-0-results gap (ADR-0007 "no silent wrong answer").
 * Renders a paste-ready `[connectors.github]` block via the shared config-block
 * helper (ADR-0030).
 *
 * Import-clean (ADR-0007): no `octokit`. The default transport uses the global
 * `fetch` (same pattern as `src/connectors/github/auth.ts`), so building the
 * connector / CLI registry never pulls the SDK. The resolved token is never
 * echoed in thrown errors.
 */

import { type ConfigBlockEntry, renderConnectorConfigBlock } from "../onboard/config-block.ts";

/** One repository surfaced for the discovery CLI. */
export interface GithubRepo {
  /** `owner/repo` full name — the value `[connectors.github].repos` expects. */
  readonly fullName: string;
  /** `public` / `private` (best-effort; derived from `visibility` or `private`). */
  readonly visibility: "public" | "private";
  /** Whether the repo is archived (read-only upstream). */
  readonly isArchived: boolean;
}

/** Result of a discovery sweep: the visible repositories, sorted by full name. */
export interface ReposResult {
  readonly repos: GithubRepo[];
}

export interface ListReposOptions {
  /** Substring filter over `full_name` (case-insensitive). */
  readonly filter?: string;
  /** Transport override (tests inject a fake; default lazy-`fetch`). */
  readonly transport?: GithubReposTransport;
  /** GitHub API base URL (override for GitHub Enterprise). */
  readonly baseUrl?: string;
  /**
   * Called once per fetched page so a CLI can render an indeterminate progress
   * counter while the sweep runs. Best-effort: any throw is ignored so progress
   * reporting never fails the listing.
   */
  readonly onProgress?: () => void;
}

/** One `GET /user/repos` page fetch, decoupled from `fetch` for tests. */
export type GithubReposTransport = (options: { token: string; url: string }) => Promise<{
  status: number;
  /** The `Link` response header (cursor pagination), or `null` when absent. */
  linkHeader: string | null;
  body: unknown;
}>;

/** Per-page ceiling (GitHub's max for `per_page`). */
const PAGE_LIMIT = 100;

/** Default transport: a `GET /user/repos` page reading the `Link` header. */
const defaultTransport: GithubReposTransport = async ({ token, url }) => {
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  let body: unknown = [];
  try {
    body = await res.json();
  } catch {
    // Non-JSON error body (e.g. an HTML 5xx) → leave body empty; status drives it.
    body = [];
  }
  return { status: res.status, linkHeader: res.headers.get("link"), body };
};

interface RawRepo {
  full_name?: string;
  visibility?: string;
  private?: boolean;
  archived?: boolean;
}

function toRepo(raw: RawRepo): GithubRepo | null {
  if (typeof raw.full_name !== "string" || raw.full_name.length === 0) return null;
  // Prefer the explicit `visibility` field; fall back to the boolean `private`.
  const visibility: "public" | "private" =
    raw.visibility === "private" || (raw.visibility === undefined && raw.private === true)
      ? "private"
      : "public";
  return {
    fullName: raw.full_name,
    visibility,
    isArchived: raw.archived === true,
  };
}

/**
 * Parse the next-page URL from a GitHub `Link` header, or `null` when there is
 * no `rel="next"` (the last page). Tolerates ordering / extra rels / whitespace.
 */
export function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match?.[1]) return match[1];
  }
  return null;
}

/**
 * Enumerate the repositories a token can see, following `Link` pagination.
 *
 * @throws {Error} when `GET /user/repos` returns a non-2xx (message carries the
 *   HTTP status + GitHub `message`, never the token).
 */
export async function listRepos(
  token: string,
  options: ListReposOptions = {},
): Promise<ReposResult> {
  const transport = options.transport ?? defaultTransport;
  const root = (options.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
  // Best-effort progress tick: a throw in the reporter must not fail the sweep.
  const tick = () => {
    try {
      options.onProgress?.();
    } catch {}
  };

  const repos: GithubRepo[] = [];
  let url: string | null = `${root}/user/repos?per_page=${PAGE_LIMIT}&sort=full_name`;

  while (url) {
    const { status, linkHeader, body }: Awaited<ReturnType<GithubReposTransport>> = await transport(
      { token, url },
    );
    tick();
    if (status < 200 || status >= 300) {
      const message =
        body &&
        typeof body === "object" &&
        typeof (body as { message?: unknown }).message === "string"
          ? (body as { message: string }).message
          : "unknown error";
      throw new Error(`github GET /user/repos failed: ${status} ${message}`);
    }
    for (const raw of Array.isArray(body) ? (body as RawRepo[]) : []) {
      const repo = toRepo(raw);
      if (repo) repos.push(repo);
    }
    url = parseNextLink(linkHeader);
  }

  let filtered = repos;
  if (options.filter !== undefined && options.filter.length > 0) {
    const needle = options.filter.toLowerCase();
    filtered = repos.filter((r) => r.fullName.toLowerCase().includes(needle));
  }

  // Sort a-z by full name (case-insensitive) for a stable, scannable listing.
  filtered.sort((a, b) => a.fullName.localeCompare(b.fullName, undefined, { sensitivity: "base" }));
  return { repos: filtered };
}

/**
 * Render a `[connectors.github]` config block the operator can paste straight
 * into `config.toml`. The `repos` array carries every discovered `owner/repo`
 * full name (a name silently ingests nothing if mistyped — that is the gap this
 * closes) with a trailing `# <visibility>` comment for readability.
 */
export function renderConfigBlock(result: ReposResult): string[] {
  const entries: ConfigBlockEntry[] = result.repos.map((r) => ({
    value: r.fullName,
    label: r.isArchived ? `${r.visibility}, archived` : r.visibility,
  }));
  return renderConnectorConfigBlock("github", entries, {
    key: "repos",
    idNote: "repos are 'owner/repo' full names — the # comment is just a visibility label",
  });
}
