/**
 * `link.remove` — delete a manual provenance link by id (ADR-0004 / ADR-0018
 * 追補, Issue #90).
 *
 * The removal half of the manual-link pair: `link.add` creates a `manual_link`
 * edge, `link.remove` deletes it. It is HITL — the host gates it behind approval
 * (`readOnlyHint: false`, no auto-apply, ADR-0004) — and appends a `LinkRemoved`
 * event that folds into the `links` projection (the row disappears from
 * `graph.related` / `graph.expand`, ADR-0002). The event log keeps the
 * add/remove pair, so the link's lifecycle stays audit-able.
 *
 * Only manual links (those carrying a `link_id`) can be removed: reducer-derived
 * provenance edges (`derived_from` / `replies_to` / `references`) have a NULL
 * `link_id` and are owned by the reducer, not removable here. Removing a
 * non-existent link is rejected at this boundary (tool error) so the host can
 * surface the mistake rather than silently no-op'ing.
 */
import { z } from "zod";
import type { Store } from "../db/index.ts";

/** Input to `link.remove`. */
export const LinkRemoveInput = z.object({
  /** Id of the manual link to remove (the `linkId` returned by `link.add`). */
  linkId: z.string().min(1),
});
/** Accepted at the call site. */
export type LinkRemoveInput = z.input<typeof LinkRemoveInput>;

export interface LinkRemoveOutput {
  linkId: string;
  status: "removed";
}

/**
 * Remove a manual link by id (append `LinkRemoved`). The host must have human
 * approval first. Rejects (tool error) a `linkId` that does not match an existing
 * manual link, so the host surfaces the mistake instead of a silent no-op.
 */
export function linkRemove(
  store: Store,
  input: LinkRemoveInput,
  now: Date = new Date(),
): LinkRemoveOutput {
  const { linkId } = LinkRemoveInput.parse(input);

  const existing = store.connection.sqlite
    .query("SELECT 1 FROM links WHERE link_id = ?")
    .get(linkId);
  if (existing === null) {
    throw new Error(`link.remove: no manual link with id ${linkId}`);
  }

  store.record({ type: "LinkRemoved", linkId }, now);
  return { linkId, status: "removed" };
}
