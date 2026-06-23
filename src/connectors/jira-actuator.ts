/**
 * Jira actuator (ADR-0036). Publishes a task as a Jira **issue** and issues
 * complete / reopen / comment against it. Distinct from the read-only jira
 * connector (`./jira.ts`); this is the egress (write) capability.
 *
 * - **identity** — externalId is `jira:<host>:<projectKey>:<issueKey>`, identical
 *   to the read connector's issue id, so a later sync dedups against the native
 *   task (loop avoidance, ADR-0036 §8). The `host` MUST be the same host the read
 *   connector ingests from (configured on `[tasks.home].host`).
 * - **auth** — Cloud HTTP Basic (`email:apiToken`, the default) or self-hosted
 *   bearer (PAT), reusing `./jira/auth.ts`. The token is the `jira-actuator`
 *   secret; `email` is non-secret config.
 * - **idempotency** — the issue carries the label `suasor` plus `suasor-task-<taskId>`;
 *   `publish` JQL-searches that label before creating, so a retried publish reuses
 *   the existing issue (the suasor layer's `published_external_id` is the primary
 *   guard). HTML-comment markers are not used (Jira has no `in:body` exact search).
 * - **transitions** — complete / reopen POST a workflow transition; the transition
 *   ids are workflow-specific (`doneTransitionId` / `reopenTransitionId` in config).
 *
 * Import-clean: fetch-based (no SDK), mirroring `./jira/client.ts`.
 */
import { z } from "zod";
import type {
  Actuator,
  ActuatorAction,
  ActuatorContext,
  PublishableTask,
  PublishResult,
} from "./actuator.ts";
import { buildJiraAuth } from "./jira/auth.ts";
import type { JiraAuth } from "./jira/client.ts";

/** `[tasks.home]` jira config slice. */
export const JiraActuatorConfig = z.object({
  /** Jira site host, e.g. `example.atlassian.net` (no scheme) — must match the read connector. */
  host: z.string().min(1),
  /** Project key the issue is created in, e.g. `ENG`. */
  project: z.string().min(1),
  /** Account email for Cloud basic auth (non-secret). */
  email: z.string().min(1).optional(),
  /** Auth scheme: `basic` (Cloud, default) or `bearer` (self-hosted PAT). */
  auth: z.enum(["basic", "bearer"]).default("basic"),
  /** Issue type name for created issues (default `Task`). */
  issueType: z.string().min(1).default("Task"),
  /** Workflow transition id mapped to "done" (for complete). */
  doneTransitionId: z.string().min(1).optional(),
  /** Workflow transition id mapped to reopen. */
  reopenTransitionId: z.string().min(1).optional(),
});
export type JiraActuatorConfig = z.infer<typeof JiraActuatorConfig>;

/** The marker label every suasor-published issue carries. */
export const SUASOR_LABEL = "suasor";

/** Per-task idempotency label (Jira labels allow no spaces). */
export function taskLabel(taskId: string): string {
  return `suasor-task-${taskId}`;
}

/** Build a minimal ADF document from plain text (Jira `/rest/api/3` needs ADF). */
export function textToAdf(text: string): Record<string, unknown> {
  return {
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

/** The Jira REST surface this actuator depends on (structural, for test fakes). */
export interface JiraActuatorClient {
  /** Find an issue carrying `label` in `projectKey` → its key, or null. */
  findIssueByLabel(args: { projectKey: string; label: string }): Promise<string | null>;
  /** Create an issue → its key. */
  createIssue(args: {
    projectKey: string;
    summary: string;
    description: Record<string, unknown>;
    issueType: string;
    labels: string[];
  }): Promise<string>;
  /** Apply a workflow transition to an issue. */
  transition(args: { issueKey: string; transitionId: string }): Promise<void>;
  /** Add a comment (ADF body) to an issue. */
  addComment(args: { issueKey: string; body: Record<string, unknown> }): Promise<void>;
}

/** How the actuator obtains its client (overridable in tests). */
export type JiraActuatorClientFactory = (auth: JiraAuth) => JiraActuatorClient;

/** Default factory: fetch-based REST client (import-clean, mirrors jira/client.ts). */
const defaultClientFactory: JiraActuatorClientFactory = (auth) => {
  const base = `https://${auth.host}${auth.apiBase}`;
  async function req(method: string, path: string, body?: unknown): Promise<Response> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: auth.authorization,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const j = (await res.json()) as { errorMessages?: unknown[]; message?: string };
        detail =
          (Array.isArray(j.errorMessages) && typeof j.errorMessages[0] === "string"
            ? j.errorMessages[0]
            : j.message) || detail;
      } catch {
        // non-JSON body
      }
      throw new Error(`jira ${method} ${path} failed: ${detail}`);
    }
    return res;
  }
  return {
    async findIssueByLabel({ projectKey, label }) {
      const jql = encodeURIComponent(`project = "${projectKey}" AND labels = "${label}"`);
      const res = await req("GET", `/search?jql=${jql}&maxResults=1&fields=key`);
      const data = (await res.json()) as { issues?: Array<{ key?: string }> };
      return data.issues?.[0]?.key ?? null;
    },
    async createIssue({ projectKey, summary, description, issueType, labels }) {
      const res = await req("POST", "/issue", {
        fields: {
          project: { key: projectKey },
          summary,
          description,
          issuetype: { name: issueType },
          labels,
        },
      });
      const data = (await res.json()) as { key?: string };
      if (!data.key) throw new Error("jira create issue returned no key");
      return data.key;
    },
    async transition({ issueKey, transitionId }) {
      await req("POST", `/issue/${issueKey}/transitions`, { transition: { id: transitionId } });
    },
    async addComment({ issueKey, body }) {
      await req("POST", `/issue/${issueKey}/comment`, { body });
    },
  };
};

/** Parse `jira:<host>:<projectKey>:<issueKey>` → its parts (throws on a bad id). */
export function parseJiraExternalId(externalId: string): {
  host: string;
  projectKey: string;
  issueKey: string;
} {
  // host may contain dots/colon(port); projectKey/issueKey are the last two segments.
  const m = /^jira:(.+):([^:]+):([^:]+)$/.exec(externalId);
  const host = m?.[1];
  const projectKey = m?.[2];
  const issueKey = m?.[3];
  if (!host || !projectKey || !issueKey) {
    throw new Error(`not a jira issue externalId: ${externalId}`);
  }
  return { host, projectKey, issueKey };
}

/**
 * Create the Jira actuator. `clientFactory` is injectable for tests; the default
 * is fetch-based.
 */
export function createJiraActuator(
  config: Record<string, unknown>,
  clientFactory: JiraActuatorClientFactory = defaultClientFactory,
): Actuator {
  const cfg = JiraActuatorConfig.parse(config);

  async function client(ctx: ActuatorContext): Promise<JiraActuatorClient> {
    const token = await ctx.secret("token");
    if (!token) {
      throw new Error("jira actuator: missing write-scoped token (secret 'token')");
    }
    const auth = buildJiraAuth({
      scheme: cfg.auth,
      host: cfg.host,
      ...(cfg.email ? { email: cfg.email } : {}),
      token,
    });
    return clientFactory(auth);
  }

  return {
    destination: "jira",

    async publish(task: PublishableTask, ctx: ActuatorContext): Promise<PublishResult> {
      const jira = await client(ctx);
      const label = taskLabel(task.taskId);
      const existing = await jira.findIssueByLabel({ projectKey: cfg.project, label });
      if (existing) {
        return { externalId: `jira:${cfg.host}:${cfg.project}:${existing}` };
      }
      const key = await jira.createIssue({
        projectKey: cfg.project,
        summary: task.title,
        description: textToAdf(task.body?.trim() || task.title),
        issueType: cfg.issueType,
        labels: [SUASOR_LABEL, label],
      });
      return { externalId: `jira:${cfg.host}:${cfg.project}:${key}` };
    },

    async act(externalId: string, action: ActuatorAction, ctx: ActuatorContext): Promise<void> {
      const { issueKey } = parseJiraExternalId(externalId);
      const jira = await client(ctx);
      switch (action.kind) {
        case "complete":
        case "reopen": {
          const transitionId =
            action.kind === "complete" ? cfg.doneTransitionId : cfg.reopenTransitionId;
          if (!transitionId) {
            throw new Error(
              `jira: ${action.kind} requires ${
                action.kind === "complete" ? "doneTransitionId" : "reopenTransitionId"
              } in [tasks.home] (workflow-specific transition id)`,
            );
          }
          await jira.transition({ issueKey, transitionId });
          return;
        }
        case "comment":
          await jira.addComment({ issueKey, body: textToAdf(action.body) });
          return;
      }
    },
  };
}
