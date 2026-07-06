/**
 * `task.publish` / `task.act` — egress write to a task's single external home
 * (ADR-0036). `task.publish` 起票s a confirmed task into the configured home
 * (GitHub Issues / Jira / Slack List) and records a body-less `TaskPublished`;
 * `task.act` issues a lifecycle operation (complete / reopen / comment) against
 * the published item (single-pane write-back) and records `TaskActionIssued`.
 *
 * The external tool is the state authority (ADR-0036 D1); suasor holds only the
 * read-derived link. Order: external write → on success only, append the audit
 * event (mirrors `draft.export`). Idempotency: the deterministic `taskId` is the
 * client-side key — a re-publish reuses the existing external item (the actuator
 * searches by marker), and the suasor layer also short-circuits when the task
 * already carries a `published_external_id`.
 */
import type { TasksConfig } from "../config/schema.ts";
import type { ActuatorAction, ActuatorContext } from "../connectors/actuator.ts";
import { loadActuator } from "../connectors/actuator-registry.ts";
import { resolveSecret } from "../connectors/secrets.ts";
import type { Store } from "../db/index.ts";
import type { TaskDestination } from "../events/types.ts";
import { McpToolError } from "../mcp/errors.ts";

/** The slice of config the publish/act services read (matches `write.config`). */
export type TaskHomeConfig = { tasks?: TasksConfig | undefined };

/**
 * Resolve the `[tasks.homes.<destination>]` config slice for a specific
 * destination (ADR-0036 R1-3). Throws `ACTUATOR_NOT_CONFIGURED` when that
 * destination's home is not configured — never at startup, only per call.
 */
function resolveHome(
  config: TaskHomeConfig,
  destination: TaskDestination,
): Record<string, unknown> {
  const slice = config.tasks?.homes?.[destination];
  if (!slice) {
    throw new McpToolError(
      "ACTUATOR_NOT_CONFIGURED",
      `No task home configured for '${destination}': set [tasks.homes.${destination}] to use it.`,
      `Configure [tasks.homes.${destination}] in suasor config (e.g. destination = github → repo = owner/repo).`,
    );
  }
  return slice as Record<string, unknown>;
}

/**
 * Resolve the destination a *new* publish targets (ADR-0036 R1-2): an explicit
 * `task.publish` argument wins, else `[tasks].default`. Throws
 * `ACTUATOR_NOT_CONFIGURED` when neither is set.
 */
function resolvePublishDestination(
  config: TaskHomeConfig,
  requested?: TaskDestination,
): TaskDestination {
  const destination = requested ?? config.tasks?.default ?? null;
  if (!destination) {
    throw new McpToolError(
      "ACTUATOR_NOT_CONFIGURED",
      "No task home configured: set [tasks].default (or pass a destination) to publish tasks.",
      "Set [tasks].default = github|jira|slack and configure the matching [tasks.homes.<dest>].",
    );
  }
  return destination;
}

/** Whether a default publish destination is fully configured (for batch publish pre-check). */
export function hasDefaultHome(config: TaskHomeConfig): boolean {
  const dest = config.tasks?.default ?? null;
  return dest !== null && Boolean(config.tasks?.homes?.[dest]);
}

/** A task row as the publish/act services need it. */
interface TaskRow {
  id: string;
  title: string;
  due_date: string | null;
  priority: string | null;
  published_destination: string | null;
  published_external_id: string | null;
}

function loadTask(store: Store, taskId: string): TaskRow | null {
  return (
    (store.connection.sqlite
      .query(
        `SELECT id, title, due_date, priority, published_destination, published_external_id
         FROM tasks WHERE id = ?`,
      )
      .get(taskId) as TaskRow | null) ?? null
  );
}

/** Build the actuator context (write-scoped secret, separate from read token). */
function actuatorContext(
  destination: TaskDestination,
  onWarn?: (m: string) => void,
): ActuatorContext {
  return {
    // Write-scoped token under a distinct keychain/env name (`<dest>-actuator`),
    // so a read-only connector token is never silently used for egress (ADR-0036 §4).
    secret: (name: string) => resolveSecret(`${destination}-actuator`, name),
    ...(onWarn ? { onWarn } : {}),
  };
}

export interface TaskPublishInput {
  taskId: string;
  /**
   * Destination to publish to (ADR-0036 R1-2). Omitted ⇒ `[tasks].default`. An
   * explicit argument is not a per-task override in the friction sense — publish
   * is already a per-task HITL call, so the choice adds no approval prompts.
   */
  destination?: TaskDestination;
}
export interface TaskPublishOutput {
  taskId: string;
  destination: TaskDestination;
  externalId: string;
  status: "published" | "existing";
}

/**
 * Publish a task to an external home. The destination is the explicit argument or
 * `[tasks].default` (ADR-0036 R1-2), resolved against `[tasks.homes.<dest>]`.
 * Idempotent: an already-published task short-circuits to `existing` (its own
 * recorded destination); otherwise the actuator publishes (itself idempotent on
 * `taskId`) and a `TaskPublished` event is appended on success.
 */
export async function taskPublish(
  store: Store,
  config: TaskHomeConfig,
  input: TaskPublishInput,
  now: Date = new Date(),
  loadActuatorImpl: typeof loadActuator = loadActuator,
): Promise<TaskPublishOutput> {
  const task = loadTask(store, input.taskId);
  if (!task) {
    throw new McpToolError("MISSING_ENTITY", `task not found: ${input.taskId}`);
  }

  // Suasor-layer idempotency: already published → no-op (no second egress call).
  // Report the task's own recorded destination (not the current default); a
  // TaskPublished always folds both columns together, so it is present here.
  if (task.published_external_id && task.published_destination) {
    return {
      taskId: task.id,
      destination: task.published_destination as TaskDestination,
      externalId: task.published_external_id,
      status: "existing",
    };
  }

  const destination = resolvePublishDestination(config, input.destination);
  const slice = resolveHome(config, destination);

  let actuator: Awaited<ReturnType<typeof loadActuator>>;
  try {
    actuator = await loadActuatorImpl(destination, slice);
  } catch (err) {
    throw new McpToolError(
      "PUBLISH_DESTINATION_INVALID",
      `no actuator for task home '${destination}': ${(err as Error).message}`,
      "GitHub Issues ships first; Jira/Slack actuators land later (ADR-0036).",
    );
  }

  let externalId: string;
  try {
    const result = await actuator.publish(
      {
        taskId: task.id,
        title: task.title,
        dueDate: task.due_date,
        priority: task.priority,
      },
      actuatorContext(destination),
    );
    externalId = result.externalId;
  } catch (err) {
    throw new McpToolError(
      "EGRESS_FAILED",
      `failed to publish task to ${destination}: ${(err as Error).message}`,
      "Check the write-scoped token (needs create permission) and the home target.",
    );
  }

  // External write succeeded → record the audit/link event (ADR-0036 §4 order).
  store.record(
    {
      type: "TaskPublished",
      taskId: task.id,
      destination,
      externalId,
      publishedAt: now.toISOString(),
    },
    now,
  );
  return { taskId: task.id, destination, externalId, status: "published" };
}

export interface TaskActInput {
  taskId: string;
  action: "complete" | "reopen" | "drop" | "comment";
  body?: string;
}
export interface TaskActOutput {
  taskId: string;
  externalId: string;
  action: "complete" | "reopen" | "drop" | "comment";
}

/**
 * Issue a lifecycle operation against a published task's external home. The task
 * must already be published; the actuator performs the write and a body-less
 * `TaskActionIssued` is appended on success.
 */
export async function taskAct(
  store: Store,
  config: TaskHomeConfig,
  input: TaskActInput,
  now: Date = new Date(),
  loadActuatorImpl: typeof loadActuator = loadActuator,
): Promise<TaskActOutput> {
  const task = loadTask(store, input.taskId);
  if (!task) {
    throw new McpToolError("MISSING_ENTITY", `task not found: ${input.taskId}`);
  }
  if (!task.published_external_id || !task.published_destination) {
    throw new McpToolError(
      "INVALID_STATE",
      `task ${input.taskId} is not published; publish it before acting on it.`,
      "Call task.publish first.",
    );
  }
  if (input.action === "comment" && !input.body?.trim()) {
    throw new McpToolError("INVALID_INPUT", "comment action requires a non-empty body.");
  }
  const destination = task.published_destination as TaskDestination;
  const externalId = task.published_external_id;

  // R1-3 critical fix (ADR-0036): resolve the actuator config from the task's OWN
  // published destination — NOT the current [tasks].default. Switching the default
  // (e.g. jira → github) must not break act/read-back on already-published tasks.
  const slice = resolveHome(config, destination);

  let actuator: Awaited<ReturnType<typeof loadActuator>>;
  try {
    actuator = await loadActuatorImpl(destination, slice);
  } catch (err) {
    throw new McpToolError(
      "PUBLISH_DESTINATION_INVALID",
      `no actuator for task home '${destination}': ${(err as Error).message}`,
    );
  }

  const action: ActuatorAction =
    input.action === "comment"
      ? { kind: "comment", body: input.body as string }
      : { kind: input.action };

  try {
    await actuator.act(externalId, action, actuatorContext(destination));
  } catch (err) {
    throw new McpToolError(
      "EGRESS_FAILED",
      `failed to ${input.action} task on ${destination}: ${(err as Error).message}`,
    );
  }

  store.record(
    {
      type: "TaskActionIssued",
      taskId: task.id,
      externalId,
      action: input.action,
      issuedAt: now.toISOString(),
    },
    now,
  );
  return { taskId: task.id, externalId, action: input.action };
}
