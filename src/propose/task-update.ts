/**
 * `task.update` — direct HITL task lifecycle transition (ADR-0004 /
 * docs/design/mcp-surface.md).
 *
 * The state-transition half of the task lifecycle: `task.create` opens a task
 * (`TaskProposed` → state `proposed`) and `task.list` reads it back, but until
 * now nothing could advance a task to `in_progress` / `completed` / `dropped`.
 * The `TaskApplied` event and its reducer already model the transition (it
 * UPDATEs `tasks.state` for an existing task); this tool is the missing write
 * surface that appends it.
 *
 * HITL: the host gates it behind approval (`readOnlyHint: false`, no auto-apply,
 * ADR-0004) and it appends a domain event through `Store.record` (append + fold,
 * ADR-0002). Like the commitment transitions, the outcome is status-reporting
 * rather than thrown: a missing task is `missing`, a same-state call is a no-op
 * (`unchanged`, no event), so replaying a redundant transition stays idempotent.
 * Task lifecycle has no forbidden transitions — any of the four states is
 * reachable from any other (e.g. reopening a `completed` task to `in_progress`).
 */
import { z } from "zod";
import type { loadActuator } from "../connectors/actuator-registry.ts";
import type { Store } from "../db/index.ts";
import { TaskPriority } from "../events/types.ts";
import { type TaskHomeConfig, taskAct } from "./task-publish.ts";

/** ISO 8601 timestamp (matches the event payload's `dueDate`). */
const IsoDateTime = z.iso.datetime({ offset: true });

/** The lifecycle states a task can be moved to (matches `TaskApplied.state`). */
export const TaskState = z.enum(["open", "in_progress", "completed", "dropped"]);
export type TaskState = z.infer<typeof TaskState>;

/** Input to `task.update`. */
export const TaskUpdateInput = z.object({
  taskId: z.string().min(1),
  state: TaskState,
  /**
   * Optional due date to (re)set on this transition (ISO 8601, ADR-0028).
   * `null` (the default) leaves the existing due date untouched — the reducer
   * COALESCEs a null update against the stored column.
   */
  dueDate: IsoDateTime.nullable().default(null),
  /** Optional priority to (re)set; null (default) leaves it untouched (ADR-0028). */
  priority: TaskPriority.nullable().default(null),
});
/** Accepted at the call site. */
export type TaskUpdateInput = z.input<typeof TaskUpdateInput>;

export interface TaskUpdateOutput {
  taskId: string;
  /**
   *   - `updated`   — the transition happened (`TaskApplied` appended);
   *   - `unchanged` — nothing changed (same state, no scheduling update; no event);
   *   - `missing`   — no task with that id exists.
   */
  status: "updated" | "unchanged" | "missing";
  /** The task's state after the call (null when `missing`). */
  state: TaskState | null;
}

interface TaskStateRow {
  state: string;
  published_external_id: string | null;
}

/** Read the current state + publish link of a task, or `null` when it does not exist. */
function loadRow(store: Store, taskId: string): TaskStateRow | null {
  return (
    (store.connection.sqlite
      .query<TaskStateRow, [string]>("SELECT state, published_external_id FROM tasks WHERE id = ?")
      .get(taskId) as TaskStateRow | null) ?? null
  );
}

/**
 * Map a target lifecycle state to the actuator action that effects it externally
 * (ADR-0036 §3). `dropped` → `drop` (abandon; best-effort — actuators whose tool
 * can't express it no-op + warn, so the local cache still records). `in_progress`
 * collapses to `reopen` (the external tools have no distinct in-progress write).
 */
function actionForState(state: TaskState): "complete" | "reopen" | "drop" | null {
  switch (state) {
    case "completed":
      return "complete";
    case "open":
    case "in_progress":
      return "reopen";
    case "dropped":
      // Best-effort egress: the actuator no-ops (+ onWarn) where the tool can't
      // express "dropped" (e.g. Slack), so the local TaskApplied still records.
      return "drop";
  }
}

/** Optional deps: the task home config + an injectable actuator loader (tests). */
export interface TaskUpdateDeps {
  config?: TaskHomeConfig;
  loadActuatorImpl?: typeof loadActuator;
}

/**
 * Transition a task's lifecycle state (append `TaskApplied`). The host must have
 * human approval first. Idempotent: a same-state call with no scheduling update
 * is a no-op (`unchanged`), a missing task is `missing` (no event in either case).
 *
 * Scheduling fields (ADR-0028): a non-null `dueDate` / `priority` (re)sets that
 * column even when the state is unchanged — so this is also the path to set/clear
 * a task's due date; a null leaves the stored value untouched (reducer COALESCE).
 */
export async function taskUpdate(
  store: Store,
  input: TaskUpdateInput,
  now: Date = new Date(),
  deps: TaskUpdateDeps = {},
): Promise<TaskUpdateOutput> {
  const { taskId, state, dueDate, priority } = TaskUpdateInput.parse(input);
  const row = loadRow(store, taskId);
  if (row === null) return { taskId, status: "missing", state: null };
  // A same-state call with no scheduling update carries no information → no event
  // (and never reaches egress for a published task).
  if (row.state === state && dueDate === null && priority === null) {
    return { taskId, status: "unchanged", state };
  }

  // Integrity rule (ADR-0036 §3): for a *published* task, a state change routes
  // through the actuator (the external tool is the state authority) BEFORE the
  // local cache is touched — never change local state first. The actuator (via
  // `taskAct`) performs the external write and records `TaskActionIssued`; on its
  // success we append `TaskApplied` as an optimistic cache (read-back, ADR-0036
  // §6, later reconciles it). If the actuator throws, we never reach the local
  // append. `dropped` has no actuator action → local-only.
  const stateChanges = row.state !== state;
  if (row.published_external_id && deps.config && stateChanges) {
    const action = actionForState(state);
    if (action) {
      await taskAct(store, deps.config, { taskId, action }, now, deps.loadActuatorImpl);
    }
  }

  store.record({ type: "TaskApplied", taskId, state, dueDate, priority }, now);
  return { taskId, status: "updated", state };
}
