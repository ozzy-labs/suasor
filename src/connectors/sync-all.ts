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
  /** Whether this connector's pass completed without throwing. */
  ok: boolean;
  /** The per-run counters when `ok`; omitted on failure. */
  outcome?: SyncOutcome;
  /** Human-readable error message when `!ok`; omitted on success. */
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
   * Per-connector sync options forwarded to `syncConnector` (embedder, extractor,
   * progress/warn sinks, …). `cursor` is intentionally not part of this — bulk
   * sync always resumes from each connector's saved cursor.
   */
  syncOptions?: Omit<SyncOptions, "cursor">;
  /**
   * Called when a connector throws so the caller can surface it (e.g. stderr)
   * without waiting for the aggregate. The run continues to the next connector.
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
 * Continue-on-error: each connector is built and synced inside a try/catch; a
 * throw is recorded as a failed entry and the loop proceeds to the next
 * connector (FR-ING-6). The aggregate's `failed` count lets the caller decide
 * the exit code (non-zero when any failed, doctor parity).
 */
export async function runBulkSync(
  store: Store,
  options: BulkSyncOptions,
): Promise<BulkSyncResult> {
  const results: BulkSyncEntry[] = [];
  let succeeded = 0;
  let failed = 0;

  for (const name of options.names) {
    options.onConnectorStart?.(name);
    const slice = options.connectors[name] ?? {};
    try {
      const connector = await options.loadConnector(name, slice);
      const outcome = await syncConnector(store, connector, {
        ...(options.syncOptions ?? {}),
      });
      results.push({ connector: name, ok: true, outcome });
      succeeded += 1;
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      results.push({ connector: name, ok: false, error: error.message });
      failed += 1;
      options.onConnectorError?.(name, error);
    }
  }

  return { results, succeeded, failed };
}
