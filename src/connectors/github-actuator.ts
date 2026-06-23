/**
 * GitHub actuator (ADR-0036). The first task-home actuator: publishes a task as
 * a real GitHub **Issue** and issues complete / reopen / comment against it.
 *
 * Optionally, when `[tasks.home].project` (a Projects v2 board node id) is set,
 * the created Issue is **also added to that board** and complete / reopen move
 * its single-select **Status** field — so the task is a first-class Issue that
 * lives on the board (the mainstream GitHub workflow), not a weak draft issue.
 * The Projects v2 surface is GraphQL; the Issue surface is REST.
 *
 * - **identity** — externalId is `gh:<owner>/<repo>:issue:<number>` (the Issue),
 *   matching the read connector (`./github.ts`) so a later sync dedups against
 *   the native task (loop avoidance, ADR-0036 §8). Adding to a board does not
 *   change the identity (it stays the Issue).
 * - **idempotency** — `publish` is idempotent on `task.taskId` (body marker +
 *   `suasor` label, searched before create). Board-add (`addProjectV2ItemById`)
 *   is itself idempotent (re-adding returns the existing item).
 * - **Status mapping** — `statusFieldId` / `doneOptionId` / `todoOptionId` are
 *   project-specific node ids (like a Jira custom workflow), so they come from
 *   config; without them complete/reopen only changes the Issue state.
 * - **secret** — the write-scoped token comes from `ctx.secret("token")` (needs
 *   `issues:write`, plus `project` write when a board is configured).
 */
import { z } from "zod";
import type {
  Actuator,
  ActuatorAction,
  ActuatorContext,
  PublishableTask,
  PublishResult,
} from "./actuator.ts";

/** `[tasks.home]` github config slice. */
export const GithubActuatorConfig = z.object({
  /** Target repository as `"owner/repo"` (the task home). */
  repo: z.string().regex(/^[^/]+\/[^/]+$/, "expected 'owner/repo'"),
  /** Optional GHES base URL; omitted for github.com. */
  baseUrl: z.string().url().optional(),
  /** Optional Projects v2 board node id (`PVT_...`) to also add the Issue to. */
  project: z.string().min(1).optional(),
  /** Single-select Status field node id (`PVTSSF_...`); needed for board Status moves. */
  statusFieldId: z.string().min(1).optional(),
  /** Status option id mapped to "done" (for complete). */
  doneOptionId: z.string().min(1).optional(),
  /** Status option id mapped to "todo"/open (for reopen). */
  todoOptionId: z.string().min(1).optional(),
});
export type GithubActuatorConfig = z.infer<typeof GithubActuatorConfig>;

/** The marker label every suasor-published issue carries (loop avoidance). */
export const SUASOR_LABEL = "suasor";

/** Build the body marker that makes `publish` idempotent on `taskId`. */
export function taskMarker(taskId: string): string {
  return `<!-- suasor:task:${taskId} -->`;
}

/**
 * The Octokit surface this actuator depends on, declared structurally so tests
 * inject a fake without importing the SDK. REST for issues, GraphQL for Projects.
 */
export interface GithubActuatorClient {
  /** Find an existing suasor issue carrying `marker` in its body → issue number, or null. */
  findIssueByMarker(args: { owner: string; repo: string; marker: string }): Promise<number | null>;
  /** Create an issue → its number + GraphQL node id (the node id is needed for board-add). */
  createIssue(args: {
    owner: string;
    repo: string;
    title: string;
    body: string;
    labels: string[];
  }): Promise<{ number: number; nodeId: string }>;
  /** The GraphQL node id of an existing issue (for board-add on act). */
  issueNodeId(args: { owner: string; repo: string; issueNumber: number }): Promise<string>;
  /** Set issue state (open/closed) with an optional reason. */
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
  /** Add an issue (by node id) to a Projects v2 board → its project item id (idempotent). */
  addToProject(args: { projectId: string; contentId: string }): Promise<string>;
  /** Set a single-select field value on a project item (board Status). */
  setProjectItemStatus(args: {
    projectId: string;
    itemId: string;
    fieldId: string;
    optionId: string;
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
      const q = `repo:${owner}/${repo} label:${SUASOR_LABEL} in:body ${marker}`;
      const res = await octokit.rest.search.issuesAndPullRequests({ q, per_page: 1 });
      const hit = res.data.items.find((i) => typeof i.body === "string" && i.body.includes(marker));
      return hit ? hit.number : null;
    },
    async createIssue({ owner, repo, title, body, labels }) {
      const res = await octokit.rest.issues.create({ owner, repo, title, body, labels });
      return { number: res.data.number, nodeId: res.data.node_id };
    },
    async issueNodeId({ owner, repo, issueNumber }) {
      const res = await octokit.rest.issues.get({ owner, repo, issue_number: issueNumber });
      return res.data.node_id;
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
    async addToProject({ projectId, contentId }) {
      const res = (await octokit.graphql(
        `mutation($projectId:ID!,$contentId:ID!){
           addProjectV2ItemById(input:{projectId:$projectId,contentId:$contentId}){ item { id } }
         }`,
        { projectId, contentId },
      )) as { addProjectV2ItemById?: { item?: { id?: string } } };
      const id = res.addProjectV2ItemById?.item?.id;
      if (!id) throw new Error("addProjectV2ItemById returned no item id");
      return id;
    },
    async setProjectItemStatus({ projectId, itemId, fieldId, optionId }) {
      await octokit.graphql(
        `mutation($projectId:ID!,$itemId:ID!,$fieldId:ID!,$optionId:String!){
           updateProjectV2ItemFieldValue(input:{
             projectId:$projectId,itemId:$itemId,fieldId:$fieldId,
             value:{ singleSelectOptionId:$optionId }
           }){ projectV2Item { id } }
         }`,
        { projectId, itemId, fieldId, optionId },
      );
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
 * Create the GitHub actuator. `clientFactory` is injectable for tests; the
 * default lazy-imports octokit.
 */
export function createGithubActuator(
  config: Record<string, unknown>,
  clientFactory: GithubActuatorClientFactory = defaultClientFactory,
): Actuator {
  const cfg = GithubActuatorConfig.parse(config);
  const { repo: ownerRepo, baseUrl } = cfg;
  // Config validated `owner/repo`, so both halves are present; defaults satisfy TS.
  const [owner = "", repo = ""] = ownerRepo.split("/");

  async function client(ctx: ActuatorContext): Promise<GithubActuatorClient> {
    const auth = await ctx.secret("token");
    if (!auth) {
      throw new Error("github actuator: missing write-scoped token (secret 'token')");
    }
    return clientFactory({ auth, ...(baseUrl ? { baseUrl } : {}) });
  }

  /** Move the board Status for an issue, when a project + status mapping is configured. */
  async function moveBoardStatus(
    gh: GithubActuatorClient,
    target: { owner: string; repo: string; issueNumber: number },
    optionId: string | undefined,
  ): Promise<void> {
    if (!cfg.project || !cfg.statusFieldId || !optionId) return;
    const contentId = await gh.issueNodeId(target);
    const itemId = await gh.addToProject({ projectId: cfg.project, contentId });
    await gh.setProjectItemStatus({
      projectId: cfg.project,
      itemId,
      fieldId: cfg.statusFieldId,
      optionId,
    });
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
      const { number, nodeId } = await gh.createIssue({
        owner,
        repo,
        title: task.title,
        body: bodyParts.join("\n\n"),
        labels: [SUASOR_LABEL],
      });
      // Optionally add the real Issue to the configured Projects v2 board.
      if (cfg.project) {
        await gh.addToProject({ projectId: cfg.project, contentId: nodeId });
      }
      return { externalId: `gh:${owner}/${repo}:issue:${number}` };
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
          await moveBoardStatus(gh, { owner: o, repo: r, issueNumber }, cfg.doneOptionId);
          return;
        case "reopen":
          await gh.setIssueState({ owner: o, repo: r, issueNumber, state: "open" });
          await moveBoardStatus(gh, { owner: o, repo: r, issueNumber }, cfg.todoOptionId);
          return;
        case "drop":
          // Abandon = close as "not planned" (GitHub's won't-do semantic). Board
          // Status is left untouched (Issue state alone reflects the drop).
          await gh.setIssueState({
            owner: o,
            repo: r,
            issueNumber,
            state: "closed",
            stateReason: "not_planned",
          });
          return;
        case "comment":
          await gh.createComment({ owner: o, repo: r, issueNumber, body: action.body });
          return;
      }
    },
  };
}
