/**
 * Bulk sync orchestration (ADR-0027, FR-ING-5/6). Runs one read-only ingest pass
 * for every *enabled* connector in config, in series, against an open store.
 *
 * This is the orchestration layer above the per-connector `syncConnector`
 * service (src/connectors/sync.ts): it enumerates the enabled connectors, builds
 * each one lazily (import-clean, ADR-0007 / NFR-PRF-1), and folds the per-run
 * `SyncOutcome` into an aggregate. A single connector's failure does not stop the
 * others (continue-on-error, FR-ING-6); the aggregate records each result so the
 * caller can set a non-zero exit code when any connector failed (doctor exit-code
 * parity).
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
  /** Per-connector results, in the order they ran. */
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
   * proceeds to the next connector (continue-on-error, FR-ING-6). When `false`
   * (fail-fast), the run stops at the first failure; the connectors that had not
   * yet run are simply absent from the result (they are not marked failed).
   */
  continueOnError?: boolean;
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
 * Run a bulk sync pass over the named connectors in series (ADR-0027).
 *
 * Continue-on-error (default, FR-ING-6): each connector is built and synced
 * inside a try/catch; a throw is recorded as a failed entry and the loop proceeds
 * to the next connector. With `continueOnError: false` (fail-fast) the loop stops
 * at the first failure. Either way the aggregate's `failed` count lets the caller
 * decide the exit code (non-zero when any failed, doctor parity).
 */
export async function runBulkSync(store: Store, options: BulkSyncOptions): Promise<BulkSyncResult> {
  const continueOnError = options.continueOnError ?? true;
  const results: BulkSyncEntry[] = [];
  let succeeded = 0;
  let failed = 0;

  // Pre-sync no-op advisory (Issue #187): an enabled connector whose scope is
  // empty (e.g. github with no repos + notifications=off, box with no folders)
  // ingests nothing and otherwise just reports `0 observed`. Warn via the shared
  // `onWarn` sink (the CLI prefixes it `warning: <name>: …`) without changing the
  // aggregate exit code — a no-op slice is not a failure. Lazy-imported to keep
  // this module's top level import-clean (the schemas pull no heavy SDK, but the
  // lazy import mirrors the connector lazy-load discipline).
  const onWarn = options.syncOptions?.onWarn;
  if (onWarn) {
    const { noopWarning } = await import("./noop-check.ts");
    for (const name of options.names) {
      const noop = noopWarning(name, options.connectors[name] ?? {});
      if (noop !== null) onWarn(`${name}: ${noop}`);
    }
  }

  for (const name of options.names) {
    options.onConnectorStart?.(name);
    const slice = options.connectors[name] ?? {};
    try {
      const connector = await options.loadConnector(name, slice);
      const outcome = await syncConnector(store, connector, {
        ...(options.syncOptions ?? {}),
      });
      if (outcome.partialFailure) {
        // The connector collected records but reported an internal partial
        // failure (e.g. one Slack workspace failed, ADR-0014). Keep the outcome
        // (counts are real) but mark the entry failed so the run exits 1 and the
        // failure is surfaced to cron / CI (ADR-0027 exit-code parity, #166).
        const summary = outcome.summaryLines?.join("; ") ?? "partial failure";
        const error = new Error(`partial failure (${summary})`);
        results.push({ connector: name, ok: false, outcome, error: error.message });
        failed += 1;
        options.onConnectorError?.(name, error);
        if (!continueOnError) break; // fail-fast: stop at the first failure
      } else {
        results.push({ connector: name, ok: true, outcome });
        succeeded += 1;
      }
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      results.push({ connector: name, ok: false, error: error.message });
      failed += 1;
      options.onConnectorError?.(name, error);
      if (!continueOnError) break; // fail-fast: stop at the first failure
    }
  }

  return { results, succeeded, failed };
}
