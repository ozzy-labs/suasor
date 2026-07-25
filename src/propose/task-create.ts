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
 * Duplicate handling (#435, [boundary/propose-1]): the task id is content-derived
 * (title + provenance), but a match against a *terminal* row (completed/dropped)
 * no longer blocks creation — recurring dictated tasks ("経費精算") mint a
 * disambiguated id (`-N` suffix) and are `created`. Only a *live* duplicate
 * (proposed / open / in_progress) short-circuits to `existing`, and the output
 * then carries the duplicate's id / state / updatedAt so the host can offer
 * reopen-vs-create explicitly instead of silently doing nothing.
 */
import { z } from "zod";
import type { Store } from "../db/index.ts";
import { TaskPriority } from "../events/types.ts";
import { resolveTaskIdentity, type TaskDuplicate } from "./identity.ts";

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
   * Present when `status` is `existing`: the live (non-terminal) duplicate that
   * short-circuited creation — id + lifecycle state + last update, so the host
   * can offer "reopen / point at it" vs. "this is genuinely new" (#435).
   */
  duplicate?: TaskDuplicate;
}

/**
 * Create a task (append `TaskProposed`). The host must have human approval first.
 *
 * Identity (#435): the id derives from title + provenance, but only a *live*
 * duplicate (proposed / open / in_progress) is a no-op (`existing`, with the
 * duplicate's id/state/updatedAt in the output). A content match whose rows are
 * all terminal (completed / dropped) creates a NEW task under a `-N`-suffixed
 * id — a recurring title is not blocked by its own history.
 *
 * `dueDate` / `priority` (ADR-0028) are NOT part of the derived id (so changing a
 * task's due date does not split it into a new task); they are carried on the
 * `TaskProposed` event and folded onto a freshly-created task.
 */
export function taskCreate(
  store: Store,
  input: TaskCreateInput,
  now: Date = new Date(),
): TaskCreateOutput {
  const { title, dueDate, priority, sourceExternalIds } = TaskCreateInput.parse(input);
  const { freeId, liveDuplicate } = resolveTaskIdentity(store.connection.sqlite, {
    title,
    sourceExternalIds,
  });
  if (liveDuplicate !== null) {
    return { taskId: liveDuplicate.taskId, status: "existing", duplicate: liveDuplicate };
  }

  store.record(
    { type: "TaskProposed", taskId: freeId, title, dueDate, priority, sourceExternalIds },
    now,
  );
  return { taskId: freeId, status: "created" };
}
