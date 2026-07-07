/**
 * Recurring-task id resolution ([boundary/propose-1], Issue #435).
 *
 * A task id is a pure content hash of title + provenance (id.ts) and terminal
 * projection rows persist forever (ADR-0002), so a dictated recurring task with
 * empty provenance ("経費精算", "call the dentist") could be created exactly once
 * in a store's lifetime: every later create/apply hashed to the same id and was
 * skipped as "existing" — conflating a genuinely new recurrence with a long-
 * completed instance.
 *
 * This resolver scopes that idempotency to *open* instances. While a task with
 * the content id is still open (`proposed` / `open` / `in_progress`) a re-create
 * is a no-op (an open duplicate the caller reports rather than duplicates), but
 * once every prior instance is terminal (`completed` / `dropped`) a fresh,
 * disambiguated id (`<base>~N`) is minted so the recurrence coexists with its
 * completed history. The chosen id is carried on the appended `TaskProposed`
 * event, so replay stays deterministic (the reducer just folds the stored id —
 * the resolver runs only on the write path, never on replay).
 */
import type { Store } from "../db/index.ts";

/** Terminal task states — a task here is history, not an open duplicate. */
export const TERMINAL_TASK_STATES: ReadonlySet<string> = new Set(["completed", "dropped"]);

/** An already-open instance blocking a fresh create/apply (host may reopen it). */
export interface OpenDuplicate {
  taskId: string;
  state: string;
  updatedAt: string;
}

export interface ResolvedTaskId {
  /** The id to use: the base content id, or a disambiguated `<base>~N` recurrence. */
  id: string;
  /** Set when an open instance already exists (the caller no-ops instead of creating). */
  openDuplicate: OpenDuplicate | null;
}

interface TaskRow {
  id: string;
  state: string;
  updated_at: string;
}

/**
 * Resolve the task id to use for a fresh create/apply of `baseId`'s content:
 *   - an open instance exists → reuse it (`openDuplicate` set; caller no-ops);
 *   - no instance exists      → `baseId` (first occurrence);
 *   - all instances terminal  → a freshly disambiguated `<base>~N` id.
 *
 * The GLOB matches only disambiguated variants (`<base>~…`); the base itself is
 * matched by equality. Task base ids are `task_<hex>` and carry no GLOB
 * metacharacters, so the pattern is literal up to the trailing `*`.
 */
export function resolveTaskId(store: Store, baseId: string): ResolvedTaskId {
  const rows = store.connection.sqlite
    .query<TaskRow, [string, string]>(
      "SELECT id, state, updated_at FROM tasks WHERE id = ? OR id GLOB ? ORDER BY id",
    )
    .all(baseId, `${baseId}~*`);

  if (rows.length === 0) return { id: baseId, openDuplicate: null };

  const open = rows.find((r) => !TERMINAL_TASK_STATES.has(r.state));
  if (open) {
    return {
      id: open.id,
      openDuplicate: { taskId: open.id, state: open.state, updatedAt: open.updated_at },
    };
  }

  // Every instance is terminal → mint the next recurrence id. The base counts as
  // occurrence 1, so recurrences run `<base>~2`, `<base>~3`, … (max suffix + 1).
  let max = 1;
  for (const row of rows) {
    if (row.id === baseId) continue;
    const suffix = Number.parseInt(row.id.slice(baseId.length + 1), 10);
    if (Number.isInteger(suffix) && suffix > max) max = suffix;
  }
  return { id: `${baseId}~${max + 1}`, openDuplicate: null };
}
