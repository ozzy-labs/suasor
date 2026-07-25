/**
 * Sync freshness derivation (Issue #442) — "is my data actually current?".
 *
 * Suasor runs no daemon: periodic `suasor sync` is delegated to the OS scheduler
 * (ADR-0027). That delegation has a silent failure mode — a cron entry whose
 * PATH does not resolve `suasor`, a laptop that was closed, a revoked token —
 * where the secretary keeps answering confidently from data that stopped moving
 * a week ago. `sync_runs` already records every run (ADR-0033), but nothing
 * *reads* it except `suasor sync status`, which the operator has to think to run.
 *
 * This module turns that record into a derived judgement so `doctor`, the brief,
 * and the MCP surface can all say the same thing. Two properties matter:
 *
 *  - **Pure, with `now` injected.** Staleness is a function of the wall clock,
 *    so — exactly as ADR-0028 does for `overdue` — it is derived at read time
 *    and never written to a projection, and `now` is a parameter so tests pin it.
 *  - **One derivation, three surfaces.** doctor / brief / MCP each render it
 *    differently but must never disagree about *whether* a connector is stale.
 */

/** The slice of a `sync_runs` row this derivation needs (`SyncRunRecord`-compatible). */
export interface SyncRunLike {
  readonly connector: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly status: string;
}

/**
 * Freshness verdict for one connector.
 *
 *  - `ok`      — a run finished successfully within the threshold
 *  - `stale`   — the last successful run is older than the threshold
 *  - `never`   — the connector is enabled but has never completed a run
 *  - `failing` — the most recent run ended in `error` (age is irrelevant: the
 *                data is not moving regardless of when it last tried)
 *
 * `failing` outranks `stale` because the fix differs: a stale connector needs a
 * scheduler, a failing one needs a credential or a network.
 */
export type SyncFreshnessState = "ok" | "stale" | "never" | "failing";

/** One connector's derived freshness. */
export interface SyncFreshness {
  readonly connector: string;
  readonly state: SyncFreshnessState;
  /** End time of the most recent completed run (ISO 8601), or `null` if none. */
  readonly lastSyncAt: string | null;
  /** Hours since `lastSyncAt` (rounded down), or `null` when there is none. */
  readonly ageHours: number | null;
  /** The staleness threshold applied to this connector, in hours. */
  readonly thresholdHours: number;
  /** One-line human explanation (the same text every surface renders). */
  readonly detail: string;
}

/**
 * Default expected cadence, in hours. Deliberately a *day*, not the hourly
 * cadence the onboarding template writes: Suasor cannot see the operator's
 * scheduler (ADR-0027), and a warning that fires because a laptop slept through
 * one hourly slot would be noise. Operators on a tighter cadence lower it.
 */
export const DEFAULT_EXPECTED_INTERVAL_HOURS = 24;

/**
 * Multiplier applied to the expected cadence before calling a connector stale.
 * One missed run is normal (a sleeping host, a slow network); the point is to
 * catch "it stopped", not "it hiccuped".
 */
export const DEFAULT_SAFETY_FACTOR = 2;

export interface SyncFreshnessOptions {
  /** Reference "now" (ISO 8601). Injectable so the derivation is deterministic under test. */
  readonly now?: string;
  /** Expected cadence in hours for connectors with no override. */
  readonly expectedIntervalHours?: number;
  /** Per-connector cadence overrides (hours), e.g. a nightly-only connector. */
  readonly perConnectorIntervalHours?: Readonly<Record<string, number>>;
  /** Multiplier applied to the expected cadence before flagging. */
  readonly safetyFactor?: number;
}

const MS_PER_HOUR = 60 * 60 * 1000;

/** Whole hours between two ISO timestamps (negative clamped to 0). */
function hoursBetween(from: string, to: string): number {
  const delta = new Date(to).getTime() - new Date(from).getTime();
  return Number.isFinite(delta) ? Math.max(0, Math.floor(delta / MS_PER_HOUR)) : 0;
}

/**
 * Derive per-connector freshness for the given enabled connectors.
 *
 * `connectors` drives the result set, not `runs`: a connector that is configured
 * but has never synced is exactly the case worth reporting, and it has no row in
 * `sync_runs` to be found by. Conversely a run row for a connector that is no
 * longer enabled is ignored — nagging about a connector the operator turned off
 * is how a warning surface loses its credibility.
 *
 * A run still in flight (`endedAt === null`) does not count as a completed sync;
 * the previous end time is what `sync_runs` holds, and if there is none the
 * connector reads as `never` while the first run is running. That is honest:
 * nothing has landed yet.
 */
export function deriveSyncFreshness(
  connectors: readonly string[],
  runs: readonly SyncRunLike[],
  options: SyncFreshnessOptions = {},
): SyncFreshness[] {
  const now = options.now ?? new Date().toISOString();
  const baseInterval = options.expectedIntervalHours ?? DEFAULT_EXPECTED_INTERVAL_HOURS;
  const factor = options.safetyFactor ?? DEFAULT_SAFETY_FACTOR;
  const overrides = options.perConnectorIntervalHours ?? {};

  const byConnector = new Map<string, SyncRunLike>();
  for (const run of runs) byConnector.set(run.connector, run);

  return [...connectors].sort().map((connector) => {
    const thresholdHours = (overrides[connector] ?? baseInterval) * factor;
    const run = byConnector.get(connector);

    if (run === undefined || run.endedAt === null) {
      return {
        connector,
        state: "never" as const,
        lastSyncAt: null,
        ageHours: null,
        thresholdHours,
        detail:
          run === undefined
            ? "never synced — the connector is configured but no run has completed"
            : "no completed run yet (first sync still in flight)",
      };
    }

    const ageHours = hoursBetween(run.endedAt, now);
    if (run.status === "error") {
      return {
        connector,
        state: "failing" as const,
        lastSyncAt: run.endedAt,
        ageHours,
        thresholdHours,
        detail: `last run failed ${ageHours}h ago — data is not advancing (see \`suasor sync status\`)`,
      };
    }
    if (ageHours > thresholdHours) {
      return {
        connector,
        state: "stale" as const,
        lastSyncAt: run.endedAt,
        ageHours,
        thresholdHours,
        detail: `last synced ${ageHours}h ago, past the ${thresholdHours}h threshold — is the scheduled sync running?`,
      };
    }
    return {
      connector,
      state: "ok" as const,
      lastSyncAt: run.endedAt,
      ageHours,
      thresholdHours,
      detail: `last synced ${ageHours}h ago`,
    };
  });
}

/** Connectors whose freshness is anything but `ok`, in report order. */
export function staleConnectors(freshness: readonly SyncFreshness[]): SyncFreshness[] {
  return freshness.filter((f) => f.state !== "ok");
}

/**
 * One-line summary of the non-`ok` connectors, or `null` when everything is
 * current. Shared by the brief warning and the doctor detail so the two never
 * drift apart in wording.
 */
export function summarizeStaleSync(freshness: readonly SyncFreshness[]): string | null {
  const stale = staleConnectors(freshness);
  if (stale.length === 0) return null;
  const parts = stale.map((f) =>
    f.state === "never"
      ? `${f.connector} (never synced)`
      : f.state === "failing"
        ? `${f.connector} (last run failed)`
        : `${f.connector} (${f.ageHours}h old)`,
  );
  return `sync is behind for ${parts.join(", ")} — answers may be missing recent activity`;
}

/** The `[sync]` slice the freshness derivation reads (`SyncConfig`-compatible). */
export interface SyncCadenceConfig {
  readonly expectedIntervalHours: number;
  readonly safetyFactor: number;
  readonly perConnectorIntervalHours: Record<string, number>;
}

/**
 * Resolve the freshness inputs from an effective config: the enabled connector
 * set plus the `[sync]` cadence expectations. One helper so the CLI (`doctor`,
 * `brief`) and the MCP server derive the same verdict from the same facts —
 * a surface that disagreed with `doctor` about staleness would be worse than
 * one that stayed silent.
 */
export function syncFreshnessInputs(
  registeredConnectors: readonly string[],
  config: {
    connectors: Record<string, { enabled?: unknown } | undefined>;
    sync: SyncCadenceConfig;
  },
): SyncCadenceConfig & { enabledConnectors: string[] } {
  const enabledConnectors = registeredConnectors.filter((name) => {
    const slice = config.connectors[name];
    return slice !== undefined && slice.enabled !== false;
  });
  return {
    enabledConnectors,
    expectedIntervalHours: config.sync.expectedIntervalHours,
    safetyFactor: config.sync.safetyFactor,
    perConnectorIntervalHours: config.sync.perConnectorIntervalHours,
  };
}
