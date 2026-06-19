/**
 * `inbox.add` — capture an inbox item (ADR-0004 / docs/design/mcp-surface.md,
 * Issue #88).
 *
 * The capture half of the daily triage loop: `inbox.list` reads items,
 * `inbox.add` is the human's own "capture this into my inbox" path, and
 * `inbox.triage` later moves an item out (→ task / decision / discard). It is
 * HITL — the host gates it behind approval (`readOnlyHint: false`, no auto-apply,
 * ADR-0004) — and appends an `InboxItemTriaged` event in the `open` state that
 * folds into the `inbox` projection (ADR-0002). (`InboxItemTriaged` is the
 * single inbox lifecycle event; capturing is just the transition into `open`.)
 *
 * Idempotence: the `inboxId` is content-derived from the source it captures
 * (id.ts), so capturing the same source twice is a no-op — the first capture
 * wins and the result reports `existing`. This keeps the append-only log free of
 * redundant captures while staying replay-deterministic.
 */
import { z } from "zod";
import type { Store } from "../db/index.ts";
import { inboxId } from "./id.ts";

/** Input to `inbox.add`. */
export const InboxAddInput = z.object({
  /** Source the inbox item references (provenance → `links`). */
  sourceExternalId: z.string().min(1),
});
/** Accepted at the call site. */
export type InboxAddInput = z.input<typeof InboxAddInput>;

export interface InboxAddOutput {
  inboxId: string;
  status: "created" | "existing";
}

/**
 * Capture an inbox item (append `InboxItemTriaged` with state `open`). The host
 * must have human approval first. Idempotent on the captured source: a second
 * capture of the same source is a no-op (`existing`).
 */
export function inboxAdd(
  store: Store,
  input: InboxAddInput,
  now: Date = new Date(),
): InboxAddOutput {
  const { sourceExternalId } = InboxAddInput.parse(input);
  const id = inboxId(sourceExternalId);

  const existing = store.connection.sqlite.query("SELECT 1 FROM inbox WHERE id = ?").get(id);
  if (existing !== null) {
    return { inboxId: id, status: "existing" };
  }

  store.record({ type: "InboxItemTriaged", inboxId: id, sourceExternalId, state: "open" }, now);
  return { inboxId: id, status: "created" };
}
