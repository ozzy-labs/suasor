/**
 * Per-resource error isolation (ADR-0014, generalized beyond Slack).
 *
 * Slack already isolates failures per workspace (ADR-0014): one workspace's
 * fetch failing does not abort the others, the failure is surfaced as an
 * aggregated `onWarn`, the workspace's prior cursor is preserved (the failure is
 * not a reset), and the run throws only when **every** workspace failed.
 *
 * The other read-only connectors (github / google / box / ms-graph) iterate a
 * list of resources (repos / Google resources / Box folders / Graph resources)
 * but historically aborted the whole pass on the first resource failure — a
 * single repo's `403` would take down every other repo's ingest in the same
 * pass (Issue #193). This helper generalizes the Slack isolation pattern so each
 * connector wraps its per-resource work and gets the same semantics:
 *
 * - a failing resource is recorded and skipped, the rest keep streaming;
 * - failures are aggregated into one human-readable `onWarn` line naming each
 *   failed resource and its error;
 * - the pass throws **only when every resource failed** (a total failure is a
 *   real error, not a partial success that would silently report exit 0);
 * - a partial failure (some succeeded, some failed) is reported via
 *   {@link IsolationResult.partialFailure} / {@link IsolationResult.summaryLines}
 *   so the sync service / CLI exit non-zero (ADR-0027) without discarding the
 *   records that were collected.
 *
 * Cursor preservation is connector-specific (github keeps a per-axis cursor;
 * google / box / ms-graph are fingerprint-based with a `null` cursor), so the
 * caller owns cursor handling. The contract here is: the per-resource body
 * generator is invoked once per resource; if it throws, the resource is counted
 * as failed and the connector's own cursor for that resource is left untouched
 * (the caller simply does not advance it). This mirrors Slack: a failed
 * workspace's prior cursor is preserved rather than reset.
 */
import type { SourceRecord, SyncContext } from "./contract.ts";

/** One resource's outcome in a per-resource isolated pass. */
export type ResourceStatus = "ok" | "failed";

/** A resource that failed mid-fetch, for the aggregated warn + summary. */
export interface ResourceFailure {
  /** Human-readable resource label (e.g. `owner/repo`, `drive`, folder id). */
  readonly resource: string;
  /** The error message extracted from the thrown error. */
  readonly message: string;
}

/** The aggregated outcome of a per-resource isolated pass. */
export interface IsolationResult {
  /** Number of resources that completed without throwing. */
  readonly okCount: number;
  /** The resources that failed mid-fetch (empty ⇒ clean run). */
  readonly failures: ResourceFailure[];
  /**
   * A partial failure: at least one resource failed AND at least one succeeded.
   * An all-failed run throws before returning, so this is never set for it; a
   * clean run leaves it `false`. The caller forwards it to the sync service so a
   * partial failure exits non-zero (ADR-0027, Issue #166) without discarding the
   * collected records.
   */
  readonly partialFailure: boolean;
  /**
   * One human-readable summary line for the pass, naming each resource's
   * outcome (e.g. `repos: owner/a=ok, owner/b=failed (cursor preserved)`), or
   * `undefined` when nothing failed (the counts line stands alone). Mirrors the
   * Slack workspace summary (ADR-0014).
   */
  readonly summaryLines?: readonly string[];
}

/** Extract a human-readable message from an unknown thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run an async generator over a list of resources with per-resource error
 * isolation (the generalized Slack pattern, ADR-0014 / Issue #193).
 *
 * For each `resource`, `body(resource)` is invoked and its records are yielded.
 * If `body` throws, the resource is recorded as failed (its label comes from
 * `label(resource)`) and the iteration continues with the next resource — the
 * records already yielded for earlier resources are kept. After every resource
 * has been attempted:
 *
 * - if **every** resource failed → throw the last error (a total failure is a
 *   real error, surfaced rather than reported as a silent empty success);
 * - otherwise → emit one aggregated `ctx.onWarn` naming each failed resource and
 *   resolve `onResult` with the {@link IsolationResult} (`partialFailure` set
 *   when some failed).
 *
 * The result is delivered via the `onResult` callback (rather than a return
 * value) because this is an async generator — the caller reads it in `finalize`.
 *
 * @param resources  the resources to iterate (repos / folders / resource kinds).
 * @param ctx        the sync context (for `onWarn`).
 * @param label      maps a resource to its human-readable label for warns.
 * @param kind       the resource-kind noun for the warn/summary (e.g. `repo`).
 * @param body       the per-resource record generator (may throw to fail it).
 * @param onResult   receives the aggregated outcome once all resources ran.
 */
export async function* syncResourcesIsolated<R>(
  resources: readonly R[],
  ctx: SyncContext,
  label: (resource: R) => string,
  kind: string,
  body: (resource: R) => AsyncIterable<SourceRecord>,
  onResult: (result: IsolationResult) => void,
): AsyncIterable<SourceRecord> {
  const failures: ResourceFailure[] = [];
  const statuses: { resource: string; status: ResourceStatus }[] = [];
  let okCount = 0;
  let lastError: unknown;

  for (const resource of resources) {
    const name = label(resource);
    try {
      yield* body(resource);
      okCount += 1;
      statuses.push({ resource: name, status: "ok" });
    } catch (error) {
      // Per-resource isolation: one resource's failure must not abort the rest.
      // Record it for the aggregated warn and continue; the caller leaves this
      // resource's cursor untouched so the failure is not a reset (ADR-0014).
      lastError = error;
      failures.push({ resource: name, message: errorMessage(error) });
      statuses.push({ resource: name, status: "failed" });
    }
  }

  // Every resource failed → surface the error rather than reporting a silent
  // empty success (mirrors Slack's all-workspaces-failed throw).
  if (resources.length > 0 && failures.length === resources.length) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  // A partial failure (some failed, some succeeded): aggregate one warn naming
  // every failed resource (which, and why) and report the partial-failure flag
  // so the run exits non-zero without discarding the collected records.
  if (failures.length > 0) {
    const detail = failures.map((f) => `${f.resource} (${f.message})`).join(", ");
    ctx.onWarn?.(`${okCount} ${kind} OK, ${failures.length} failed (cursor preserved) — ${detail}`);
  }

  const parts = statuses.map(({ resource, status }) =>
    status === "failed" ? `${resource}=failed (cursor preserved)` : `${resource}=ok`,
  );
  onResult({
    okCount,
    failures,
    partialFailure: failures.length > 0,
    ...(failures.length > 0 ? { summaryLines: [`${kind}s: ${parts.join(", ")}`] } : {}),
  });
}
