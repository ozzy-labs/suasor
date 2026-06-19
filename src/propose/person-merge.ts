/**
 * `person.merge` — collapse two resolved persons into one (ADR-0022 / ADR-0004,
 * Issue #92).
 *
 * The write half of person identity resolution: `person.list` reads the
 * `persons` / `person_identities` projection, and `person.merge` is the
 * operator's explicit "these two are the same human" action — there is no
 * automatic fuzzy de-duplication (ADR-0022 rejects it as high-cost to undo). It
 * is HITL (the host gates it behind approval, `readOnlyHint: false`, no
 * auto-apply, ADR-0004) and appends a `PersonsMerged` event that reassigns the
 * source person's identities to the target. Recorded as an event, the merge is
 * auditable and reversible via `person.split`.
 *
 * Validation at the boundary so the host can surface the error: a self-merge
 * (same id on both ends) carries no meaning, and the source person must exist
 * with at least one identity to move. Re-running a merge whose identities have
 * already moved is reported `noop` (the reducer is idempotent regardless).
 */
import { z } from "zod";
import type { Store } from "../db/index.ts";

/** Input to `person.merge`. */
export const PersonMergeInput = z.object({
  /** Person that survives and absorbs the other's identities. */
  targetPersonId: z.string().min(1),
  /** Person whose identities move to the target (emptied). */
  sourcePersonId: z.string().min(1),
});
/** Accepted at the call site. */
export type PersonMergeInput = z.input<typeof PersonMergeInput>;

export interface PersonMergeOutput {
  targetPersonId: string;
  sourcePersonId: string;
  /** Identities reassigned from source to target. */
  movedIdentities: number;
  status: "merged" | "noop";
}

/**
 * Merge `sourcePersonId` into `targetPersonId` (append `PersonsMerged`). The
 * host must have human approval first. Rejects a self-merge and an unknown
 * source person. Reports `noop` when the source already has no identities to
 * move (idempotent — re-applying the same merge is harmless).
 */
export function personMerge(
  store: Store,
  input: PersonMergeInput,
  now: Date = new Date(),
): PersonMergeOutput {
  const { targetPersonId, sourcePersonId } = PersonMergeInput.parse(input);

  if (targetPersonId === sourcePersonId) {
    throw new Error("person.merge: cannot merge a person into itself");
  }

  const sqlite = store.connection.sqlite;
  const countRow = sqlite
    .query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM person_identities WHERE person_id = ?",
    )
    .get(sourcePersonId);
  const movedIdentities = countRow?.n ?? 0;

  // The source must be a person we actually know (has, or had, identities). An
  // unknown id is surfaced so the operator can't merge away a typo.
  if (movedIdentities === 0) {
    const exists = sqlite.query("SELECT 1 FROM persons WHERE id = ?").get(sourcePersonId);
    if (exists === null) {
      throw new Error(`person.merge: unknown source person '${sourcePersonId}'`);
    }
    return { targetPersonId, sourcePersonId, movedIdentities: 0, status: "noop" };
  }

  store.record({ type: "PersonsMerged", targetPersonId, sourcePersonId }, now);
  return { targetPersonId, sourcePersonId, movedIdentities, status: "merged" };
}
