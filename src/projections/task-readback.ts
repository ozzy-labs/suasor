/**
 * State read-back (ADR-0036 §6 / D4). After a connector sync, reflect the
 * external tool's state back onto the **published** task it hosts: read the
 * ingested source's state and, when it differs from the local task, append a
 * `TaskApplied` so the prioritised view stays accurate.
 *
 * This is read → local event ONLY — it never writes to the external tool, so it
 * cannot loop (the operate path is `task.act`, a separate egress; ADR-0036 §6).
 * The external tool is the state authority (D1); this is how the local cache
 * converges to it.
 *
 * Scope: GitHub Issues (incl. `closed(not_planned)` → dropped via meta
 * `state_reason`) + Jira (status category). Slack read-back needs the slack
 * connector to ingest List items (follow-up); unknown state → leave untouched.
 */
import type { Store } from "../db/index.ts";
import type { TaskState } from "../propose/task-update.ts";

interface PublishedSourceRow {
  taskId: string;
  taskState: string;
  sourceType: string;
  meta: string;
}

/**
 * Map an ingested source's state to the task lifecycle state it implies, or
 * `null` when it cannot be derived (leave the task untouched — conservative).
 */
export function taskStateFromSource(
  sourceType: string,
  meta: Record<string, unknown>,
): TaskState | null {
  if (sourceType === "github_issue") {
    if (meta.state === "closed") {
      // A "not planned" close is a won't-do → dropped; any other close → completed.
      return meta.state_reason === "not_planned" ? "dropped" : "completed";
    }
    if (meta.state === "open") return "open";
  }
  if (sourceType === "jira_issue") {
    // Workflow-agnostic status category (ADR-0036 §6): custom status names map
    // onto new/indeterminate/done. Unknown / empty → null (conservative).
    switch (meta.statusCategory) {
      case "done":
        return "completed";
      case "indeterminate":
        return "in_progress";
      case "new":
        return "open";
    }
  }
  // slack list items: not yet reflected (read side does not ingest lists).
  return null;
}

/**
 * Reflect external state onto published tasks. For every published task whose
 * home item was ingested as a source, derive the implied state and append
 * `TaskApplied` only when it differs from the current task state (a diff guard
 * — the reducer rewrites `updated_at` on any apply, so an unconditional append
 * would spam a redundant event every sync).
 *
 * @returns the number of tasks whose state was reflected (TaskApplied appended).
 */
export function reconcileReadback(store: Store, now: Date = new Date()): number {
  const rows = store.connection.sqlite
    .query(
      `SELECT t.id AS taskId, t.state AS taskState, s.source_type AS sourceType, s.meta AS meta
       FROM tasks t
       JOIN sources s ON s.external_id = t.published_external_id
       WHERE t.published_external_id IS NOT NULL`,
    )
    .all() as PublishedSourceRow[];

  let reflected = 0;
  for (const row of rows) {
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(row.meta) as Record<string, unknown>;
    } catch {
      continue;
    }
    const derived = taskStateFromSource(row.sourceType, meta);
    if (derived === null || derived === row.taskState) continue; // unknown or unchanged → skip
    store.record({ type: "TaskApplied", taskId: row.taskId, state: derived }, now);
    reflected++;
  }
  return reflected;
}
