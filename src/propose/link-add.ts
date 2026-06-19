/**
 * `link.add` — create a manual provenance link between two entities (ADR-0004 /
 * ADR-0018 追補, Issue #90).
 *
 * The write half of the knowledge graph: `graph.related` / `graph.expand` read
 * the `links` projection, and `link.add` is the human/agent's own "relate these
 * two entities" path — beyond the reducer-derived provenance edges
 * (`derived_from` / `replies_to` / `references`). It is HITL — the host gates it
 * behind approval (`readOnlyHint: false`, no auto-apply, ADR-0004) — and appends
 * a `LinkAdded` event that folds into the `links` projection with the
 * `manual_link` relation (ADR-0002).
 *
 * Idempotence: the `linkId` is content-derived from the directed endpoint pair
 * (id.ts), so adding the same link twice is a no-op — the first add wins and the
 * result reports `existing`. Self-loops (an entity linked to itself) are rejected
 * at this boundary so the host can surface the error rather than silently storing
 * a meaningless edge.
 */
import { z } from "zod";
import type { Store } from "../db/index.ts";
import { manualLinkId } from "./id.ts";

/** A single graph endpoint: a projection entity addressed by kind + id. */
const Endpoint = {
  kind: z.string().min(1),
  id: z.string().min(1),
};

/** Input to `link.add`. */
export const LinkAddInput = z.object({
  fromKind: Endpoint.kind,
  fromId: Endpoint.id,
  toKind: Endpoint.kind,
  toId: Endpoint.id,
});
/** Accepted at the call site. */
export type LinkAddInput = z.input<typeof LinkAddInput>;

export interface LinkAddOutput {
  linkId: string;
  status: "created" | "existing";
}

/**
 * Create a manual link (append `LinkAdded`). The host must have human approval
 * first. Idempotent on the directed endpoint pair: a second add of the same link
 * is a no-op (`existing`). Rejects a self-loop (same kind + id on both ends).
 */
export function linkAdd(store: Store, input: LinkAddInput, now: Date = new Date()): LinkAddOutput {
  const { fromKind, fromId, toKind, toId } = LinkAddInput.parse(input);

  // A self-loop carries no provenance meaning — reject so the host surfaces it.
  if (fromKind === toKind && fromId === toId) {
    throw new Error("link.add: cannot link an entity to itself");
  }

  const linkId = manualLinkId({ fromKind, fromId, toKind, toId });
  const existing = store.connection.sqlite
    .query("SELECT 1 FROM links WHERE link_id = ?")
    .get(linkId);
  if (existing !== null) {
    return { linkId, status: "existing" };
  }

  store.record({ type: "LinkAdded", linkId, fromKind, fromId, toKind, toId }, now);
  return { linkId, status: "created" };
}
