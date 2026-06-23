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
 * `state_reason`) + Jira (status category + due/priority) + Slack Lists
 * (`slack_list_item` raw cells interpreted with the `[tasks.home]` column config,
 * option C). Unknown external state → leave the task untouched.
 */
import type { Store } from "../db/index.ts";
import type { TaskState } from "../propose/task-update.ts";

interface PublishedSourceRow {
  taskId: string;
  taskState: string;
  taskDue: string | null;
  taskPriority: string | null;
  sourceType: string;
  meta: string;
}

/**
 * Normalize a Jira bare due date (`YYYY-MM-DD`) to the ISO-8601-with-offset form
 * `TaskApplied.dueDate` requires (UTC midnight), or `null` when absent/malformed.
 * Comparing the normalized value (not the raw bare date) keeps the diff guard
 * stable against the stored ISO column (ADR-0036 §6).
 */
export function normalizeJiraDue(raw: unknown): string | null {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  return `${raw}T00:00:00+00:00`;
}

/** The `[tasks.home]` slack column/option mapping read-back needs to interpret cells. */
export interface SlackHomeColumns {
  slackCheckboxColumnId?: string;
  slackStatusColumnId?: string;
  slackDoneOptionId?: string;
  slackTodoOptionId?: string;
  slackDroppedOptionId?: string;
}

/** A raw Slack List cell (as stored in `slack_list_item` meta.cells). */
interface SlackCell {
  column_id?: string;
  checkbox?: boolean;
  select?: string[];
}

/**
 * Interpret a Slack List item's raw cells into a task state, using the
 * `[tasks.home]` column config (ADR-0036 §6, option C: cells are ingested raw,
 * interpreted here — the connector stays config-free). Checkbox column wins when
 * configured (done/not-done); else a status single-select maps via the option
 * ids. Returns `null` when it cannot be derived (unconfigured / no match).
 */
export function slackStateFromCells(cells: SlackCell[], home: SlackHomeColumns): TaskState | null {
  if (home.slackCheckboxColumnId) {
    const cell = cells.find((c) => c.column_id === home.slackCheckboxColumnId);
    if (cell && typeof cell.checkbox === "boolean") return cell.checkbox ? "completed" : "open";
  }
  if (home.slackStatusColumnId) {
    const cell = cells.find((c) => c.column_id === home.slackStatusColumnId);
    const opt = cell?.select?.[0];
    if (opt) {
      if (opt === home.slackDoneOptionId) return "completed";
      if (opt === home.slackDroppedOptionId) return "dropped";
      if (opt === home.slackTodoOptionId) return "open";
    }
  }
  return null;
}

/** Map a Jira priority name (case-insensitive) to a suasor priority, or `null`. */
export function mapJiraPriority(raw: unknown): "low" | "normal" | "high" | null {
  if (typeof raw !== "string") return null;
  switch (raw.toLowerCase()) {
    case "highest":
    case "high":
      return "high";
    case "medium":
      return "normal";
    case "low":
    case "lowest":
      return "low";
    default:
      return null; // custom schemes → leave the local value untouched (COALESCE)
  }
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
 * Reflect external state (lifecycle + Jira due/priority) onto published tasks.
 * For every published task whose home item was ingested as a source, derive the
 * implied state/due/priority and append `TaskApplied` only when something differs
 * (a diff guard — the reducer rewrites `updated_at` on any apply, so an
 * unconditional append would spam a redundant event every sync).
 *
 * Due/priority are read back for `jira_issue` only (GitHub Issues have no due).
 * Because the reducer COALESCEs a null update, this can SET/CHANGE due/priority
 * but **cannot CLEAR** them (deleting a Jira due date is not reflected, ADR-0036
 * §6 — a documented limitation). A change is only appended with a valid derived
 * state, so the reducer's direct `state =` assignment never sees a stale state.
 *
 * @returns the number of tasks reflected (TaskApplied appended).
 */
export function reconcileReadback(
  store: Store,
  now: Date = new Date(),
  slackHome?: SlackHomeColumns | null,
): number {
  const rows = store.connection.sqlite
    .query(
      `SELECT t.id AS taskId, t.state AS taskState, t.due_date AS taskDue,
              t.priority AS taskPriority, s.source_type AS sourceType, s.meta AS meta
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
    const derived =
      row.sourceType === "slack_list_item"
        ? slackHome
          ? slackStateFromCells((meta.cells as SlackCell[]) ?? [], slackHome)
          : null // no [tasks.home] slack config available → can't interpret cells
        : taskStateFromSource(row.sourceType, meta);
    if (derived === null) continue; // unknown external state → leave the task untouched

    // `dropped` is a suasor-side decision the tool may not be able to express
    // (a drop that no-op'd egress, ADR-0036 §3). Read-back must NOT un-drop such
    // a task — keep it sticky (state + due/priority). A genuine external drop
    // (github not_planned, a slack dropped option) yields derived === "dropped"
    // and falls through to the diff guard (a no-op).
    if (row.taskState === "dropped" && derived !== "dropped") continue;

    // Jira also carries due/priority; github_issue does not (→ null = no change).
    const isJira = row.sourceType === "jira_issue";
    const due = isJira ? normalizeJiraDue(meta.dueDate) : null;
    const priority = isJira ? mapJiraPriority(meta.priority) : null;

    const stateChanged = derived !== row.taskState;
    const dueChanged = due !== null && due !== row.taskDue;
    const priorityChanged = priority !== null && priority !== row.taskPriority;
    if (!stateChanged && !dueChanged && !priorityChanged) continue;

    store.record(
      {
        type: "TaskApplied",
        taskId: row.taskId,
        state: derived,
        // null ⇒ COALESCE keeps the stored value (no change / can't clear).
        dueDate: dueChanged ? due : null,
        priority: priorityChanged ? priority : null,
      },
      now,
    );
    reflected++;
  }
  return reflected;
}
