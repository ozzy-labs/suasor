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
import type { Store } from "../db/index.ts";
import { TaskPriority } from "../events/types.ts";

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
}

/** Read the current state of a task, or `null` when it does not exist. */
function currentState(store: Store, taskId: string): string | null {
  const row = store.connection.sqlite
    .query<TaskStateRow, [string]>("SELECT state FROM tasks WHERE id = ?")
    .get(taskId);
  return row?.state ?? null;
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
export function taskUpdate(
  store: Store,
  input: TaskUpdateInput,
  now: Date = new Date(),
): TaskUpdateOutput {
  const { taskId, state, dueDate, priority } = TaskUpdateInput.parse(input);
  const current = currentState(store, taskId);
  if (current === null) return { taskId, status: "missing", state: null };
  // A same-state call with no scheduling update carries no information → no event.
  if (current === state && dueDate === null && priority === null) {
    return { taskId, status: "unchanged", state };
  }

  store.record({ type: "TaskApplied", taskId, state, dueDate, priority }, now);
  return { taskId, status: "updated", state };
}
