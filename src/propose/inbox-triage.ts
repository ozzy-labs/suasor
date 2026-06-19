/**
 * `inbox.triage` — move an open inbox item out of the inbox (ADR-0004 /
 * docs/design/mcp-surface.md, Issue #88).
 *
 * The resolution half of the daily triage loop (`inbox.add` captures →
 * `inbox.triage` resolves). It is a small state machine over the `inbox`
 * projection: an item must be `open` to be triaged; the action decides where it
 * goes:
 *   - `task`     → append `TaskProposed` (a task derived from the item's source)
 *                  + transition the inbox item to `done`.
 *   - `decision` → append `DecisionRecorded` (a decision derived from the source)
 *                  + transition the inbox item to `done`.
 *   - `discard`  → transition the inbox item to `dismissed` (no derived entity).
 *
 * Both entity-producing actions and the inbox transition are appended as
 * separate domain events through `Store.record` (ADR-0002); the created task /
 * decision carries the inbox item's source as provenance (→ `links`). The task /
 * decision creation reuses the same content-derived ids as `task.create` /
 * `decision.record` (id.ts), so a triaged item lands on the same projection row
 * a human or the model would have produced for equal content.
 *
 * It is HITL — the host gates it behind approval (`readOnlyHint: false`, no
 * auto-apply, ADR-0004).
 *
 * Invalid transitions are rejected (thrown), not silently ignored, so the host
 * surfaces the error: triaging a missing item, or an item already moved out of
 * `open` (`snoozed` / `done` / `dismissed`), is a `TriageError`.
 */
import { z } from "zod";
import type { Store } from "../db/index.ts";
import { entityId } from "./id.ts";

/** Actions an open inbox item can be triaged into (Issue #88 state machine). */
export const TRIAGE_ACTIONS = ["task", "decision", "discard"] as const;
export const TriageAction = z.enum(TRIAGE_ACTIONS);
export type TriageAction = z.infer<typeof TriageAction>;

/** Input to `inbox.triage`. */
export const InboxTriageInput = z
  .object({
    inboxId: z.string().min(1),
    action: TriageAction,
    /**
     * Title for the derived task/decision. Required for `task` / `decision`,
     * ignored for `discard`.
     */
    title: z.string().min(1).optional(),
    /** Rationale for the derived decision (`decision` action only). */
    rationale: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.action === "task" || value.action === "decision") && value.title === undefined) {
      ctx.addIssue({
        code: "custom",
        message: `action '${value.action}' requires a title`,
        path: ["title"],
      });
    }
  });
/** Accepted at the call site. */
export type InboxTriageInput = z.input<typeof InboxTriageInput>;

export interface InboxTriageOutput {
  inboxId: string;
  action: TriageAction;
  /** Inbox state after triage: `done` (task/decision) or `dismissed` (discard). */
  state: "done" | "dismissed";
  /** Id of the entity created by the action (task/decision), if any. */
  createdEntityId?: string;
}

/** A rejected triage transition (missing item / item not in `open`). */
export class TriageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TriageError";
  }
}

interface InboxStateRow {
  state: string;
  source_external_id: string;
}

/**
 * Triage an open inbox item. The host must have human approval first.
 *
 * @throws {TriageError} when the item does not exist or is not in `open` state.
 */
export function inboxTriage(
  store: Store,
  input: InboxTriageInput,
  now: Date = new Date(),
): InboxTriageOutput {
  const { inboxId, action, title, rationale } = InboxTriageInput.parse(input);
  const sqlite = store.connection.sqlite;

  const row = sqlite
    .query<InboxStateRow, [string]>("SELECT state, source_external_id FROM inbox WHERE id = ?")
    .get(inboxId);
  if (row === null) {
    throw new TriageError(`inbox item not found: ${inboxId}`);
  }
  // State machine: only an `open` item may be triaged. Re-triaging an item that
  // is already snoozed / done / dismissed is an invalid transition (rejected),
  // so the host cannot accidentally double-resolve or re-open a resolved item.
  if (row.state !== "open") {
    throw new TriageError(
      `inbox item ${inboxId} is '${row.state}', not 'open' — cannot triage (action: ${action})`,
    );
  }

  const sourceExternalIds = [row.source_external_id];

  if (action === "discard") {
    store.record(
      {
        type: "InboxItemTriaged",
        inboxId,
        sourceExternalId: row.source_external_id,
        state: "dismissed",
      },
      now,
    );
    return { inboxId, action, state: "dismissed" };
  }

  // task / decision: create the derived entity, then move the item to `done`.
  // `title` is guaranteed present here by InboxTriageInput's superRefine.
  const itemTitle = title as string;
  let createdEntityId: string;
  if (action === "task") {
    createdEntityId = entityId({
      kind: "task",
      candidateId: "inbox.triage",
      title: itemTitle,
      sourceExternalIds,
    });
    store.record(
      { type: "TaskProposed", taskId: createdEntityId, title: itemTitle, sourceExternalIds },
      now,
    );
  } else {
    const decisionRationale = rationale ?? "";
    createdEntityId = entityId({
      kind: "decision",
      candidateId: "inbox.triage",
      title: itemTitle,
      rationale: decisionRationale,
      sourceExternalIds,
    });
    store.record(
      {
        type: "DecisionRecorded",
        decisionId: createdEntityId,
        title: itemTitle,
        rationale: decisionRationale,
        sourceExternalIds,
      },
      now,
    );
  }

  store.record(
    { type: "InboxItemTriaged", inboxId, sourceExternalId: row.source_external_id, state: "done" },
    now,
  );

  return { inboxId, action, state: "done", createdEntityId };
}
