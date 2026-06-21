/**
 * Bulk sync orchestration (ADR-0027, FR-ING-5/6). Runs one read-only ingest pass
 * for every *enabled* connector in config against an open store.
 *
 * This is the orchestration layer above the per-connector `syncConnector`
 * service (src/connectors/sync.ts): it enumerates the enabled connectors, builds
 * each one lazily (import-clean, ADR-0007 / NFR-PRF-1), and folds the per-run
 * `SyncOutcome` into an aggregate. A single connector's failure does not stop the
 * others (continue-on-error, FR-ING-6); the aggregate records each result so the
 * caller can set a non-zero exit code when any connector failed (doctor exit-code
 * parity).
 *
 * Connectors run **concurrently** in a bounded worker pool (Issue #269): each one
 * hits a different API host (an independent rate-limit bucket), so syncing them in
 * parallel overlaps the network waits that dominate a sync cycle (6 connectors:
 * ~30min → ~5min). The pool is bounded (default {@link DEFAULT_CONCURRENCY}) to
 * avoid swamping a shared local sidecar (embedding / extraction). Per-resource work
 * *inside* a connector stays serial (googleapis / graph.microsoft share one quota
 * bucket) — that is the connector's own concern (per-resource.ts) and is untouched
 * here. The DB is a single shared `bun:sqlite` connection whose synchronous API
 * serialises every SQL statement, so concurrent connectors never race for a write
 * lock. The aggregate is assembled in **`names` order** (not completion order) so
 * the result and exit code are deterministic regardless of which connector finishes
 * first.
 *
 * Fail-fast (`continueOnError: false`) keeps its original **serial** semantics —
 * "stop at the first failure, leave the rest absent" only has a well-defined
 * meaning in order — so it bypasses the pool. The default continue-on-error path is
 * the one that parallelises.
 *
 * Idempotent + short-lived (ADR-0027): each connector's pass is delta-detected
 * (fingerprint/cursor, FR-ING-3) and the whole run terminates after one pass per
 * connector — no daemon. Scheduling is delegated to the OS (docs/guide/scheduling.md).
 *
 * Import-clean: only contract/service types are imported at the top level; the
 * connector SDKs are pulled lazily through the injected `loadConnector`.
 */
import type { Store } from "../db/index.ts";
import type { ConnectorConfig } from "./contract.ts";
import { type SyncOptions, type SyncOutcome, syncConnector } from "./sync.ts";

/** Default bound on concurrently-syncing connectors (Issue #269). */
export const DEFAULT_CONCURRENCY = 4;
/**
 * Concurrency above which the pool warns but does not cap (Issue #269). A high
 * fan-out risks contending on a shared local sidecar (embedding / extraction) and
 * burning API rate-limit budget, so it is surfaced — but never silently clamped.
 */
export const CONCURRENCY_WARN_THRESHOLD = 8;

/** Per-connector result inside a bulk run: either an outcome or an error. */
export interface BulkSyncEntry {
  /** Connector name / CLI verb (e.g. "github"). */
  connector: string;
  /**
   * Whether this connector's pass counts as a success for the run's exit code.
   * `false` when the connector threw **or** reported a partial failure (e.g. one
   * Slack workspace failed while others synced, ADR-0014 / #166) — the latter
   * keeps `outcome` (records were collected) but still fails the run so cron / CI
   * can gate on it (ADR-0027 exit-code parity).
   */
  ok: boolean;
  /**
   * The per-run counters. Present on a clean success **and** on a partial failure
   * (records were collected); omitted only when the connector threw outright.
   */
  outcome?: SyncOutcome;
  /**
   * Human-readable error message when `!ok`; omitted on a clean success. On a
   * partial failure this summarizes which sub-units failed (the connector still
   * collected records, so `outcome` is also present).
   */
  error?: string;
}

/** Aggregate result of a `suasor sync` run. */
export interface BulkSyncResult {
  /**
   * Per-connector results. Ordered by `names` (the requested order), not by which
   * connector finished first — deterministic even when connectors run concurrently.
   */
  results: BulkSyncEntry[];
  /** Count of connectors that completed without error. */
  succeeded: number;
  /** Count of connectors that threw (continue-on-error still ran the rest). */
  failed: number;
}

/** How the bulk orchestrator builds one connector — injected for testability. */
export type ConnectorLoader = (
  name: string,
  config: ConnectorConfig,
) => Promise<Parameters<typeof syncConnector>[1]>;

export interface BulkSyncOptions {
  /**
   * Connector names to run, in order. The caller is responsible for selecting
   * the enabled set (see {@link selectEnabledConnectors}) and applying any
   * `--connector` filter before calling.
   */
  names: string[];
  /** Per-connector config slices, keyed by connector name (`{}` when absent). */
  connectors: Record<string, ConnectorConfig>;
  /** Builds a connector by name (lazy SDK import). Injected for tests. */
  loadConnector: ConnectorLoader;
  /**
   * Sync options forwarded to every connector's `syncConnector` call (embedder,
   * extractor, progress/warn sinks, …). When omitted, each connector resumes from
   * its own saved cursor. Setting `cursor: null` here forces a full re-scan for
   * **all** connectors uniformly (the bulk-level `--full` flag) — there is no
   * per-connector cursor override at the bulk level by design.
   */
  syncOptions?: SyncOptions;
  /**
   * When `true` (default), a connector's failure is recorded and the run
   * proceeds (continue-on-error, FR-ING-6); connectors run concurrently in a
   * bounded pool. When `false` (fail-fast), the run is **serial** and stops at the
   * first failure; the connectors that had not yet run are simply absent from the
   * result (they are not marked failed).
   */
  continueOnError?: boolean;
  /**
   * Max connectors syncing at once on the continue-on-error path (default
   * {@link DEFAULT_CONCURRENCY}, effectively `min(default, names.length)`). Values
   * `> {@link CONCURRENCY_WARN_THRESHOLD}` warn via `syncOptions.onWarn` but are
   * not capped. Non-positive values are treated as `1` (serial). Ignored on the
   * fail-fast path (always serial).
   */
  concurrency?: number;
  /**
   * Called when a connector throws so the caller can surface it (e.g. stderr)
   * without waiting for the aggregate. With continue-on-error the run proceeds to
   * the next connector; with fail-fast it then stops.
   */
  onConnectorError?: (connector: string, error: Error) => void;
  /** Called right before a connector's pass starts (e.g. to reset a progress label). */
  onConnectorStart?: (connector: string) => void;
}

/**
 * Select the enabled connectors from a config's connector map, restricted to the
 * given registered set. A connector is enabled when its `[connectors.<name>]`
 * slice exists and does not set `enabled = false` — identical to the rule used by
 * `connectors list` / `doctor`. The result preserves the registry order passed in
 * (sorted, deterministic).
 *
 * @param registered Registered connector names (registry order, e.g. `connectorNames()`).
 * @param connectors The config's `connectors` map (`[connectors.<name>]` slices).
 */
export function selectEnabledConnectors(
  registered: readonly string[],
  connectors: Record<string, ConnectorConfig>,
): string[] {
  return registered.filter((name) => {
    const slice = connectors[name];
    return slice !== undefined && slice.enabled !== false;
  });
}

/**
 * Resolve the effective pool size for `names.length` connectors at the requested
 * `concurrency`. Clamps to `[1, names.length]` (no point spawning more workers
 * than connectors, and never less than one). A `> {@link CONCURRENCY_WARN_THRESHOLD}`
 * request warns (via `onWarn`) but is not capped — the warning, not a silent
 * clamp, is the contract (Issue #269).
 */
export function resolveConcurrency(
  count: number,
  concurrency: number | undefined,
  onWarn?: (message: string) => void,
): number {
  const requested = concurrency ?? DEFAULT_CONCURRENCY;
  if (requested > CONCURRENCY_WARN_THRESHOLD) {
    onWarn?.(
      `concurrency ${requested} exceeds the recommended max ${CONCURRENCY_WARN_THRESHOLD} ` +
        "(may contend on a shared sidecar / API rate limits)",
    );
  }
  // Non-positive → serial (1). Never exceed the connector count.
  const lowerBounded = requested > 0 ? requested : 1;
  return Math.max(1, Math.min(lowerBounded, Math.max(0, count)));
}

/** Fold one connector's `syncConnector` result into a result-slot mutation. */
function classifyOutcome(
  name: string,
  outcome: SyncOutcome,
  onConnectorError?: (connector: string, error: Error) => void,
): { entry: BulkSyncEntry; ok: boolean } {
  if (outcome.partialFailure) {
    // The connector collected records but reported an internal partial failure
    // (e.g. one Slack workspace failed, ADR-0014). Keep the outcome (counts are
    // real) but mark the entry failed so the run exits 1 and the failure is
    // surfaced to cron / CI (ADR-0027 exit-code parity, #166).
    const summary = outcome.summaryLines?.join("; ") ?? "partial failure";
    const error = new Error(`partial failure (${summary})`);
    onConnectorError?.(name, error);
    return { entry: { connector: name, ok: false, outcome, error: error.message }, ok: false };
  }
  return { entry: { connector: name, ok: true, outcome }, ok: true };
}

/** Run one connector's pass, mapping a throw to a failed entry (continue-on-error). */
async function runOneConnector(
  store: Store,
  name: string,
  options: BulkSyncOptions,
): Promise<{ entry: BulkSyncEntry; ok: boolean }> {
  options.onConnectorStart?.(name);
  const slice = options.connectors[name] ?? {};
  try {
    const connector = await options.loadConnector(name, slice);
    const outcome = await syncConnector(store, connector, { ...(options.syncOptions ?? {}) });
    return classifyOutcome(name, outcome, options.onConnectorError);
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    options.onConnectorError?.(name, error);
    return { entry: { connector: name, ok: false, error: error.message }, ok: false };
  }
}

/** Emit the pre-sync no-op advisory (Issue #187) for empty connector slices. */
async function emitNoopWarnings(options: BulkSyncOptions): Promise<void> {
  const onWarn = options.syncOptions?.onWarn;
  if (!onWarn) return;
  // Lazy-imported to keep this module's top level import-clean (the schemas pull
  // no heavy SDK, but the lazy import mirrors the connector lazy-load discipline).
  const { noopWarning } = await import("./noop-check.ts");
  for (const name of options.names) {
    const noop = noopWarning(name, options.connectors[name] ?? {});
    if (noop !== null) onWarn(`${name}: ${noop}`);
  }
}

/**
 * Fail-fast (serial) run: stop at the first failure. The connectors after the
 * failure never run and are absent from the result (not marked failed) — the
 * original ADR-0027 semantics, kept serial because "stop at the first" is only
 * well-defined in order.
 */
async function runSerialFailFast(store: Store, options: BulkSyncOptions): Promise<BulkSyncResult> {
  const results: BulkSyncEntry[] = [];
  let succeeded = 0;
  let failed = 0;
  for (const name of options.names) {
    const { entry, ok } = await runOneConnector(store, name, options);
    results.push(entry);
    if (ok) {
      succeeded += 1;
    } else {
      failed += 1;
      break; // fail-fast: stop at the first failure
    }
  }
  return { results, succeeded, failed };
}

/**
 * Continue-on-error run with a bounded worker pool (Issue #269). Connectors run
 * concurrently up to {@link resolveConcurrency}; each result is written into its
 * `names`-ordered slot so the aggregate is deterministic (independent of finish
 * order). Workers pull the next unclaimed index from a shared cursor — a simple
 * bounded semaphore without an external dependency.
 */
async function runBoundedPool(store: Store, options: BulkSyncOptions): Promise<BulkSyncResult> {
  const { names } = options;
  const slots = new Array<BulkSyncEntry>(names.length);
  const oks = new Array<boolean>(names.length);
  const poolSize = resolveConcurrency(
    names.length,
    options.concurrency,
    options.syncOptions?.onWarn,
  );

  let next = 0;
  const worker = async (): Promise<void> => {
    // Each worker repeatedly claims the next index until the queue drains. The
    // claim is a synchronous read+increment (single-threaded event loop ⇒ no race).
    for (;;) {
      const index = next;
      if (index >= names.length) return;
      next += 1;
      const name = names[index] as string;
      const { entry, ok } = await runOneConnector(store, name, options);
      slots[index] = entry;
      oks[index] = ok;
    }
  };

  await Promise.all(Array.from({ length: poolSize }, () => worker()));

  // Slots are already in `names` order; fold counts deterministically.
  const results = slots.slice(0, names.length);
  const succeeded = oks.filter((ok) => ok).length;
  const failed = oks.length - succeeded;
  return { results, succeeded, failed };
}

/**
 * Run a bulk sync pass over the named connectors (ADR-0027).
 *
 * Default (continue-on-error, FR-ING-6): connectors run **concurrently** in a
 * bounded pool (Issue #269); a throw / partial failure is recorded as a failed
 * entry and the rest keep running. With `continueOnError: false` (fail-fast) the
 * run is **serial** and stops at the first failure. Either way the result is
 * ordered by `names` and the aggregate's `failed` count lets the caller decide the
 * exit code (non-zero when any failed, doctor parity).
 */
export async function runBulkSync(store: Store, options: BulkSyncOptions): Promise<BulkSyncResult> {
  // Pre-sync no-op advisory (Issue #187): warn for enabled-but-empty slices before
  // any connector runs, in `names` order, so the advisory is deterministic and not
  // interleaved with concurrent progress output.
  await emitNoopWarnings(options);

  const continueOnError = options.continueOnError ?? true;
  return continueOnError ? runBoundedPool(store, options) : runSerialFailFast(store, options);
}
