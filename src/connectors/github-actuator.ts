/**
 * GitHub Issues actuator (ADR-0036). The first task-home actuator: publishes a
 * task as a GitHub Issue and issues complete / reopen / comment against it.
 *
 * - **identity** — the published item's `externalId` is `gh:<owner>/<repo>:issue:<number>`,
 *   matching the read connector's issue id (`./github.ts`) so a later sync of the
 *   same issue dedups against the native task (loop avoidance, ADR-0036 §8).
 * - **idempotency** — `publish` is idempotent on `task.taskId`: the issue body
 *   carries an HTML-comment marker `<!-- suasor:task:<taskId> -->` and the label
 *   `suasor`. Before creating, `publish` searches the repo for that marker and
 *   reuses the existing issue, so a retried/timed-out publish never double-creates
 *   (ADR-0036 §4). The marker also lets `projections rebuild` re-recognise
 *   suasor-originated issues when the local id-map is lost.
 * - **secret** — the **write-scoped** token comes from `ctx.secret("token")`
 *   (keychain + env; needs `issues:write`, ADR-0036 §4).
 *
 * Import-clean: octokit is lazy-imported inside the client factory so registering
 * the actuator pulls no SDK (mirrors `./github.ts`).
 */
import { z } from "zod";
import type {
  Actuator,
  ActuatorAction,
  ActuatorContext,
  PublishableTask,
  PublishResult,
} from "./actuator.ts";

/** `[tasks]` github-home config slice the actuator needs. */
export const GithubActuatorConfig = z.object({
  /** Target repository as `"owner/repo"` (the task home). */
  repo: z.string().regex(/^[^/]+\/[^/]+$/, "expected 'owner/repo'"),
  /** Optional GHES base URL; omitted for github.com. */
  baseUrl: z.string().url().optional(),
});
export type GithubActuatorConfig = z.infer<typeof GithubActuatorConfig>;

/** The marker label every suasor-published issue carries (loop avoidance). */
export const SUASOR_LABEL = "suasor";

/** Build the body marker that makes `publish` idempotent on `taskId`. */
export function taskMarker(taskId: string): string {
  return `<!-- suasor:task:${taskId} -->`;
}

/**
 * The Octokit REST surface this actuator depends on, declared structurally so
 * tests inject a fake without importing the SDK (mirrors `OctokitLike`).
 */
export interface GithubActuatorClient {
  /** Find an existing suasor issue carrying `marker` in its body → issue number, or null. */
  findIssueByMarker(args: { owner: string; repo: string; marker: string }): Promise<number | null>;
  /** Create an issue → its number. */
  createIssue(args: {
    owner: string;
    repo: string;
    title: string;
    body: string;
    labels: string[];
  }): Promise<number>;
  /** Set issue state (open/closed) with an optional reason (e.g. "not_planned"). */
  setIssueState(args: {
    owner: string;
    repo: string;
    issueNumber: number;
    state: "open" | "closed";
    stateReason?: "completed" | "not_planned" | null;
  }): Promise<void>;
  /** Add a comment to an issue. */
  createComment(args: {
    owner: string;
    repo: string;
    issueNumber: number;
    body: string;
  }): Promise<void>;
}

/** How the actuator obtains its client (overridable in tests). */
export type GithubActuatorClientFactory = (options: {
  auth: string;
  baseUrl?: string;
}) => Promise<GithubActuatorClient> | GithubActuatorClient;

/** Default factory: lazy-imports `octokit` so registration stays import-clean. */
const defaultClientFactory: GithubActuatorClientFactory = async ({ auth, baseUrl }) => {
  const { Octokit } = await import("octokit");
  const octokit = new Octokit({ auth, ...(baseUrl ? { baseUrl } : {}) });
  return {
    async findIssueByMarker({ owner, repo, marker }) {
      // Search the repo for the marker in issue bodies. Scoped to suasor-labelled
      // issues to keep the query cheap and avoid matching unrelated text.
      const q = `repo:${owner}/${repo} label:${SUASOR_LABEL} in:body ${marker}`;
      const res = await octokit.rest.search.issuesAndPullRequests({ q, per_page: 1 });
      const hit = res.data.items.find((i) => typeof i.body === "string" && i.body.includes(marker));
      return hit ? hit.number : null;
    },
    async createIssue({ owner, repo, title, body, labels }) {
      const res = await octokit.rest.issues.create({ owner, repo, title, body, labels });
      return res.data.number;
    },
    async setIssueState({ owner, repo, issueNumber, state, stateReason }) {
      await octokit.rest.issues.update({
        owner,
        repo,
        issue_number: issueNumber,
        state,
        ...(stateReason ? { state_reason: stateReason } : {}),
      });
    },
    async createComment({ owner, repo, issueNumber, body }) {
      await octokit.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body });
    },
  };
};

/** Parse `gh:<owner>/<repo>:issue:<number>` → its parts (throws on a bad id). */
export function parseIssueExternalId(externalId: string): {
  owner: string;
  repo: string;
  issueNumber: number;
} {
  const m = /^gh:([^/]+)\/([^:]+):issue:(\d+)$/.exec(externalId);
  const owner = m?.[1];
  const repo = m?.[2];
  const num = m?.[3];
  if (!owner || !repo || !num) {
    throw new Error(`not a github issue externalId: ${externalId}`);
  }
  return { owner, repo, issueNumber: Number(num) };
}

/**
 * Create the GitHub Issues actuator. `clientFactory` is injectable for tests; the
 * default lazy-imports octokit.
 */
export function createGithubActuator(
  config: Record<string, unknown>,
  clientFactory: GithubActuatorClientFactory = defaultClientFactory,
): Actuator {
  const { repo: ownerRepo, baseUrl } = GithubActuatorConfig.parse(config);
  // Config validated `owner/repo`, so both halves are present; defaults satisfy TS.
  const [owner = "", repo = ""] = ownerRepo.split("/");

  async function client(ctx: ActuatorContext): Promise<GithubActuatorClient> {
    const auth = await ctx.secret("token");
    if (!auth) {
      // Surfaced upstream as a structured ACTUATOR_NOT_CONFIGURED error.
      throw new Error("github actuator: missing write-scoped token (secret 'token')");
    }
    return clientFactory({ auth, ...(baseUrl ? { baseUrl } : {}) });
  }

  return {
    destination: "github",

    async publish(task: PublishableTask, ctx: ActuatorContext): Promise<PublishResult> {
      const gh = await client(ctx);
      const marker = taskMarker(task.taskId);
      // Idempotency: reuse an existing suasor issue for this task if present.
      const existing = await gh.findIssueByMarker({ owner, repo, marker });
      if (existing !== null) {
        return { externalId: `gh:${owner}/${repo}:issue:${existing}` };
      }
      const bodyParts = [task.body?.trim(), marker].filter(Boolean) as string[];
      const issueNumber = await gh.createIssue({
        owner,
        repo,
        title: task.title,
        body: bodyParts.join("\n\n"),
        labels: [SUASOR_LABEL],
      });
      return { externalId: `gh:${owner}/${repo}:issue:${issueNumber}` };
    },

    async act(externalId: string, action: ActuatorAction, ctx: ActuatorContext): Promise<void> {
      const { owner: o, repo: r, issueNumber } = parseIssueExternalId(externalId);
      const gh = await client(ctx);
      switch (action.kind) {
        case "complete":
          await gh.setIssueState({
            owner: o,
            repo: r,
            issueNumber,
            state: "closed",
            stateReason: "completed",
          });
          return;
        case "reopen":
          await gh.setIssueState({ owner: o, repo: r, issueNumber, state: "open" });
          return;
        case "comment":
          await gh.createComment({ owner: o, repo: r, issueNumber, body: action.body });
          return;
      }
    },
  };
}
