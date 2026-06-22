/**
 * GitHub Projects v2 actuator (ADR-0036). A second GitHub task-home, distinct
 * from the Issues actuator (`./github-actuator.ts`): Projects v2 is a different
 * surface (GraphQL, project items / draft issues, a custom single-select Status
 * field) so it is its own `destination` (`github_projects`) with its own actuator.
 *
 * - **publish** — adds a **draft issue** to the configured project
 *   (`addProjectV2DraftIssue`). externalId is `ghp:<projectId>:item:<itemId>`.
 *   The body carries the marker `<!-- suasor:task:<taskId> -->`; idempotency is
 *   primarily the suasor-layer `published_external_id` short-circuit, with a
 *   best-effort first-page marker scan to absorb publish RPC retries.
 * - **act** — `complete` / `reopen` set the project's single-select **Status**
 *   field via `updateProjectV2ItemFieldValue`. The field/option node ids are
 *   project-specific (like a Jira custom workflow), so they come from config
 *   (`statusFieldId` / `doneOptionId` / `todoOptionId`); without them the action
 *   fails with a descriptive error. `comment` is unsupported for Projects v2
 *   draft issues.
 * - **secret** — the write-scoped token comes from `ctx.secret("token")` (needs
 *   `project` write scope).
 *
 * Import-clean: octokit is lazy-imported inside the client factory.
 */
import { z } from "zod";
import type {
  Actuator,
  ActuatorAction,
  ActuatorContext,
  PublishableTask,
  PublishResult,
} from "./actuator.ts";
import { taskMarker } from "./github-actuator.ts";

/** `[tasks.home]` github_projects config slice. */
export const GithubProjectsActuatorConfig = z.object({
  /** Projects v2 node id (`PVT_...`). */
  project: z.string().min(1),
  /** Single-select Status field node id (`PVTSSF_...`); needed for complete/reopen. */
  statusFieldId: z.string().min(1).optional(),
  /** Status option id mapped to "done" (for complete). */
  doneOptionId: z.string().min(1).optional(),
  /** Status option id mapped to "todo"/open (for reopen). */
  todoOptionId: z.string().min(1).optional(),
});
export type GithubProjectsActuatorConfig = z.infer<typeof GithubProjectsActuatorConfig>;

/** The GraphQL surface this actuator depends on (structural, for test fakes). */
export interface GithubProjectsClient {
  /** Find a draft item whose body carries `marker` → its project item id, or null. */
  findDraftItemByMarker(args: { projectId: string; marker: string }): Promise<string | null>;
  /** Add a draft issue to the project → its project item id. */
  addDraftIssue(args: { projectId: string; title: string; body: string }): Promise<string>;
  /** Set a single-select field value on a project item. */
  setSingleSelectField(args: {
    projectId: string;
    itemId: string;
    fieldId: string;
    optionId: string;
  }): Promise<void>;
}

/** How the actuator obtains its client (overridable in tests). */
export type GithubProjectsClientFactory = (options: {
  auth: string;
}) => Promise<GithubProjectsClient> | GithubProjectsClient;

/** Default factory: lazy-imports `octokit` and drives the Projects v2 GraphQL API. */
const defaultClientFactory: GithubProjectsClientFactory = async ({ auth }) => {
  const { Octokit } = await import("octokit");
  const octokit = new Octokit({ auth });
  return {
    async findDraftItemByMarker({ projectId, marker }) {
      const res = (await octokit.graphql(
        `query($projectId:ID!){
           node(id:$projectId){ ... on ProjectV2 {
             items(first:100){ nodes { id content { ... on DraftIssue { body } } } }
           } }
         }`,
        { projectId },
      )) as { node?: { items?: { nodes?: Array<{ id: string; content?: { body?: string } }> } } };
      const nodes = res.node?.items?.nodes ?? [];
      const hit = nodes.find(
        (n) => typeof n.content?.body === "string" && n.content.body.includes(marker),
      );
      return hit ? hit.id : null;
    },
    async addDraftIssue({ projectId, title, body }) {
      const res = (await octokit.graphql(
        `mutation($projectId:ID!,$title:String!,$body:String){
           addProjectV2DraftIssue(input:{projectId:$projectId,title:$title,body:$body}){
             projectItem { id }
           }
         }`,
        { projectId, title, body },
      )) as { addProjectV2DraftIssue?: { projectItem?: { id?: string } } };
      const id = res.addProjectV2DraftIssue?.projectItem?.id;
      if (!id) throw new Error("addProjectV2DraftIssue returned no project item id");
      return id;
    },
    async setSingleSelectField({ projectId, itemId, fieldId, optionId }) {
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

/** Parse `ghp:<projectId>:item:<itemId>` → its parts (throws on a bad id). */
export function parseProjectItemExternalId(externalId: string): {
  projectId: string;
  itemId: string;
} {
  const m = /^ghp:([^:]+):item:(.+)$/.exec(externalId);
  const projectId = m?.[1];
  const itemId = m?.[2];
  if (!projectId || !itemId) {
    throw new Error(`not a github_projects externalId: ${externalId}`);
  }
  return { projectId, itemId };
}

/**
 * Create the GitHub Projects v2 actuator. `clientFactory` is injectable for tests;
 * the default lazy-imports octokit.
 */
export function createGithubProjectsActuator(
  config: Record<string, unknown>,
  clientFactory: GithubProjectsClientFactory = defaultClientFactory,
): Actuator {
  const cfg = GithubProjectsActuatorConfig.parse(config);

  async function client(ctx: ActuatorContext): Promise<GithubProjectsClient> {
    const auth = await ctx.secret("token");
    if (!auth) {
      throw new Error("github_projects actuator: missing write-scoped token (secret 'token')");
    }
    return clientFactory({ auth });
  }

  return {
    destination: "github_projects",

    async publish(task: PublishableTask, ctx: ActuatorContext): Promise<PublishResult> {
      const gh = await client(ctx);
      const marker = taskMarker(task.taskId);
      // Best-effort idempotency: reuse an existing draft item for this task.
      const existing = await gh.findDraftItemByMarker({ projectId: cfg.project, marker });
      if (existing !== null) {
        return { externalId: `ghp:${cfg.project}:item:${existing}` };
      }
      // A draft issue carries no label, so the body marker is its sole
      // loop-avoidance / idempotency signal (vs. the Issues actuator's label).
      const bodyParts = [task.body?.trim(), marker].filter(Boolean) as string[];
      const itemId = await gh.addDraftIssue({
        projectId: cfg.project,
        title: task.title,
        body: bodyParts.join("\n\n"),
      });
      return { externalId: `ghp:${cfg.project}:item:${itemId}` };
    },

    async act(externalId: string, action: ActuatorAction, ctx: ActuatorContext): Promise<void> {
      const { projectId, itemId } = parseProjectItemExternalId(externalId);
      if (action.kind === "comment") {
        throw new Error("github_projects: comment is not supported (Projects v2 draft issue)");
      }
      const optionId = action.kind === "complete" ? cfg.doneOptionId : cfg.todoOptionId;
      if (!cfg.statusFieldId || !optionId) {
        throw new Error(
          `github_projects: ${action.kind} requires statusFieldId + ${
            action.kind === "complete" ? "doneOptionId" : "todoOptionId"
          } in [tasks.home]`,
        );
      }
      const gh = await client(ctx);
      await gh.setSingleSelectField({
        projectId,
        itemId,
        fieldId: cfg.statusFieldId,
        optionId,
      });
    },
  };
}
