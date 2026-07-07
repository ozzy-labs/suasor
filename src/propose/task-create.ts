/**
 * `task.create` — direct HITL task creation (ADR-0004 / docs/design/mcp-surface.md,
 * Issue #12 追補 D2).
 *
 * The fourth write tool: where `propose.*` packages model-suggested candidates,
 * `task.create` is the human's own "add this task" path (e.g. the next-actions
 * skill surfaces a task the user dictates). It is still HITL — the host gates it
 * behind approval (`readOnlyHint: false`, no auto-apply, ADR-0004) — and appends
 * a `TaskProposed` event that folds into the `tasks` projection (ADR-0002).
 *
 * Idempotence is scoped to *open* instances ([boundary/propose-1], Issue #435):
 * the `taskId` is content-derived from the title + provenance, so while an
 * instance with that content is still open (proposed / open / in_progress) a
 * re-create is a no-op (`existing`, reporting the open `duplicate` so a host can
 * offer reopen-vs-create). But once every prior instance is terminal (completed /
 * dropped) a fresh, disambiguated id is minted (`created`) so a genuinely
 * recurring task ("経費精算") is no longer blocked for the store's lifetime.
 */
import { z } from "zod";
import type { Store } from "../db/index.ts";
import { TaskPriority } from "../events/types.ts";
import { entityId } from "./id.ts";
import { type OpenDuplicate, resolveTaskId } from "./recurrence.ts";

/** ISO 8601 timestamp (matches the event payload's `dueDate`). */
const IsoDateTime = z.iso.datetime({ offset: true });

/** Input to `task.create`. */
export const TaskCreateInput = z.object({
  title: z.string().min(1),
  /** Optional due date (ISO 8601), when the task carries one (ADR-0028). */
  dueDate: IsoDateTime.nullable().default(null),
  /** Optional priority (low/normal/high); null when unprioritised (ADR-0028). */
  priority: TaskPriority.nullable().default(null),
  /** Source(s) this task derives from (provenance → `links`). */
  sourceExternalIds: z.array(z.string().min(1)).default([]),
});
/** Accepted at the call site (defaults applied by `parse`). */
export type TaskCreateInput = z.input<typeof TaskCreateInput>;

export interface TaskCreateOutput {
  taskId: string;
  status: "created" | "existing";
  /**
   * Present only when `status === "existing"`: the still-open instance that
   * blocked creation (its id / state / updated_at). Lets a host offer explicit
   * reopen-vs-create instead of the create silently vanishing ([boundary/
   * propose-1]).
   */
  duplicate?: OpenDuplicate;
}

/**
 * Create a task (append `TaskProposed`). The host must have human approval first.
 * Idempotent on *open* content: an open task with the derived id is a no-op
 * (`existing`, with the open `duplicate` reported); once every prior instance is
 * terminal (completed / dropped) a fresh disambiguated id is minted (`created`)
 * so the task can recur (`resolveTaskId`).
 *
 * `dueDate` / `priority` (ADR-0028) are NOT part of the derived id (so changing a
 * task's due date does not split it into a new task — id stays title + provenance);
 * they are carried on the `TaskProposed` event and folded onto a freshly-created
 * task.
 */
export function taskCreate(
  store: Store,
  input: TaskCreateInput,
  now: Date = new Date(),
): TaskCreateOutput {
  const { title, dueDate, priority, sourceExternalIds } = TaskCreateInput.parse(input);
  const baseId = entityId({
    kind: "task",
    candidateId: "task.create",
    title,
    sourceExternalIds,
  });

  const resolved = resolveTaskId(store, baseId);
  if (resolved.openDuplicate !== null) {
    return {
      taskId: resolved.openDuplicate.taskId,
      status: "existing",
      duplicate: resolved.openDuplicate,
    };
  }

  store.record(
    { type: "TaskProposed", taskId: resolved.id, title, dueDate, priority, sourceExternalIds },
    now,
  );
  return { taskId: resolved.id, status: "created" };
}
