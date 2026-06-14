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
 * Idempotence mirrors `propose.apply`: the `taskId` is content-derived from the
 * title + provenance, so re-creating the same task upserts the same row rather
 * than duplicating it; the result reports whether the event was appended
 * (`created`) or the task already existed (`existing`).
 */
import { z } from "zod";
import type { Store } from "../db/index.ts";
import { entityId } from "./id.ts";

/** Input to `task.create`. */
export const TaskCreateInput = z.object({
  title: z.string().min(1),
  /** Source(s) this task derives from (provenance → `links`). */
  sourceExternalIds: z.array(z.string().min(1)).default([]),
});
/** Accepted at the call site (defaults applied by `parse`). */
export type TaskCreateInput = z.input<typeof TaskCreateInput>;

export interface TaskCreateOutput {
  taskId: string;
  status: "created" | "existing";
}

/**
 * Create a task (append `TaskProposed`). The host must have human approval first.
 * Idempotent on content: an existing task with the derived id is a no-op.
 */
export function taskCreate(
  store: Store,
  input: TaskCreateInput,
  now: Date = new Date(),
): TaskCreateOutput {
  const { title, sourceExternalIds } = TaskCreateInput.parse(input);
  const taskId = entityId({
    kind: "task",
    candidateId: "task.create",
    title,
    sourceExternalIds,
  });

  const existing = store.connection.sqlite.query("SELECT 1 FROM tasks WHERE id = ?").get(taskId);
  if (existing !== null) {
    return { taskId, status: "existing" };
  }

  store.record({ type: "TaskProposed", taskId, title, sourceExternalIds }, now);
  return { taskId, status: "created" };
}
