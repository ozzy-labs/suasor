/**
 * `person.split` — move one identity off a person into another (ADR-0022 /
 * ADR-0004, Issue #92).
 *
 * The inverse of `person.merge`: corrects an over-merge by detaching a single
 * `(connector, handle)` identity and binding it to another person. By default
 * the identity goes to its **own** content-derived person (the natural 1 handle
 * = 1 person home, `personIdFor`), which is what "undo a wrong merge" means; an
 * explicit `newPersonId` can target a specific person instead.
 *
 * HITL (the host gates it behind approval, `readOnlyHint: false`, no auto-apply,
 * ADR-0004). Appends a `PersonSplit` event so the move is auditable and itself
 * reversible (a later `person.merge` re-collapses them). Validation at the
 * boundary: the identity must exist; splitting it to the person it already
 * resolves to is reported `noop`.
 */
import { z } from "zod";
import type { Store } from "../db/index.ts";
import { identityKey, personIdFor } from "../projections/person.ts";

/** Input to `person.split`. */
export const PersonSplitInput = z.object({
  /** Connector of the identity to move out. */
  connector: z.string().min(1),
  /** Handle of the identity to move out. */
  handle: z.string().min(1),
  /**
   * Person to move the identity to. Omit to send it to its own content-derived
   * person (the default "undo a merge" home for this `(connector, handle)`).
   */
  newPersonId: z.string().min(1).optional(),
});
/** Accepted at the call site. */
export type PersonSplitInput = z.input<typeof PersonSplitInput>;

export interface PersonSplitOutput {
  connector: string;
  handle: string;
  /** Person the identity was (or already is) bound to after the split. */
  newPersonId: string;
  status: "split" | "noop";
}

/**
 * Split a `(connector, handle)` identity off its current person (append
 * `PersonSplit`). The host must have human approval first. Rejects an unknown
 * identity. Reports `noop` when the identity already resolves to the target.
 */
export function personSplit(
  store: Store,
  input: PersonSplitInput,
  now: Date = new Date(),
): PersonSplitOutput {
  const { connector, handle, newPersonId: requested } = PersonSplitInput.parse(input);
  const newPersonId = requested ?? personIdFor(connector, handle);

  const key = identityKey(connector, handle);
  const row = store.connection.sqlite
    .query<{ person_id: string }, [string]>(
      "SELECT person_id FROM person_identities WHERE identity_key = ?",
    )
    .get(key);
  if (row === null) {
    throw new Error(`person.split: unknown identity '${key}'`);
  }
  if (row.person_id === newPersonId) {
    return { connector, handle, newPersonId, status: "noop" };
  }

  store.record({ type: "PersonSplit", connector, handle, newPersonId }, now);
  return { connector, handle, newPersonId, status: "split" };
}
