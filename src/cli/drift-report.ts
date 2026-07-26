/**
 * Rendering for the generic discovery drift view (`<connector> <verb> --new`,
 * ADR-0049 — ADR-0039 Layer 1 generalized onto the discovery registry).
 *
 * Pure: takes an already-computed {@link DiscoveryDiff} and returns the lines to
 * write, so the exact wording an operator acts on is testable without a
 * credential or a network round-trip (the CLI command only owns the I/O).
 *
 * Two wording invariants live here and are pinned by tests:
 * - "nothing was ingested or written" is stated on the actionable path. The
 *   explicit-enumeration model is the whole reason drift exists; the output must
 *   not read as though it fixed it.
 * - a **narrowed** run says "removed: not checked", never an empty removed
 *   section. An empty section reads as "none", which would be a claim the
 *   narrowed enumeration cannot support.
 */
import type { DiscoveryDiff, DiscoveryScope } from "../connectors/discovery-specs.ts";
import { renderConnectorConfigBlock } from "../connectors/onboard/config-block.ts";

/** stdout / stderr line buffers for one drift report (no trailing newlines). */
export interface DriftReportLines {
  /** Report body (stdout). */
  readonly out: readonly string[];
  /** Next-step guidance (stderr), empty when there is nothing to act on. */
  readonly err: readonly string[];
}

/** Inputs the drift renderer needs beyond the diff itself. */
export interface DriftReportInput {
  /** Connector name (e.g. `github`). */
  readonly connector: string;
  /** Noun for the items (e.g. `repository`). */
  readonly itemNoun: string;
  /** The connector's config scope (key + id note for the paste fragment). */
  readonly scope: DiscoveryScope;
  /** The computed difference. */
  readonly diff: DiscoveryDiff;
}

/** Render the human-readable drift report. */
export function renderDriftReport({
  connector,
  itemNoun,
  scope,
  diff,
}: DriftReportInput): DriftReportLines {
  const out: string[] = [];
  const err: string[] = [];

  if (diff.added.length === 0) {
    out.push(
      `no new ${itemNoun}(s): every ${itemNoun} visible to this credential is already in ` +
        `[connectors.${connector}].${scope.key}`,
    );
  } else {
    out.push(`${diff.added.length} new ${itemNoun}(s) visible but not in config:`);
    for (const item of diff.added) out.push(`  ${item.value}  (${item.label})`);
    out.push("");
    out.push(
      ...renderConnectorConfigBlock(
        connector,
        diff.added.map((item) => ({ value: item.value, label: item.label })),
        { key: scope.key, idNote: scope.idNote },
      ),
    );
    err.push(
      `next: merge the ids above into the existing [connectors.${connector}].${scope.key} list ` +
        `(nothing was ingested or written), then run \`suasor ${connector} sync\`.`,
    );
  }

  if (!diff.removedComputed) {
    out.push(
      "",
      "removed: not checked (--filter / --root narrows the view, so an id that is out of " +
        "view is indistinguishable from one that is gone)",
    );
  } else if (diff.removed.length > 0) {
    out.push(
      "",
      `${diff.removed.length} configured ${itemNoun}(s) not visible to this credential ` +
        "(renamed, deleted, or no longer permitted — they sync nothing):",
    );
    for (const id of diff.removed) out.push(`  ${id}`);
  }

  return { out, err };
}
