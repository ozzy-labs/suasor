/**
 * Connector contract (ADR-0007 / docs/design/connector-contract.md).
 *
 * Every ingest source implements this read-only contract. The shape of ingest
 * — read-only, cross-source identity, delta detection, local body retention —
 * is uniform across sources even though each upstream API differs.
 *
 * This module is **import-clean**: it declares types/interfaces only and pulls
 * no connector SDK. Concrete connectors (e.g. `./github.ts`) lazy-import their
 * heavy SDK inside `sync` so registering a connector never loads octokit/etc.
 * (ADR-0007 "import-clean"; mirrors the CLI lazy-import discipline, NFR-PRF-1).
 */

/** Where a connector resumes from, and how it reports progress. */
export interface SyncContext {
  /**
   * Opaque resume cursor from the previous run for delta APIs, or `null` on the
   * first run / for fingerprint-based connectors. The connector interprets it;
   * the sync service treats it as opaque and persists whatever the connector
   * returns in {@link SyncResult.cursor} for the next run
   * (ADR-0007 "差分", FR-ING-3).
   */
  readonly cursor: string | null;
  /**
   * Resolve a named secret (e.g. an API token) for this connector. Backed by
   * the OS keychain with an env override (NFR-PRV-4); see `./secrets.ts`.
   * Returns `null` when the secret is not configured.
   */
  secret(name: string): Promise<string | null>;
  /**
   * Optional progress signal a connector may emit for *intermediate* work that
   * the sync service can't observe (e.g. per-page fetch). The service already
   * emits one progress event per yielded record on its own, so connectors that
   * only stream records need not call this — doing so would double-count.
   */
  readonly onProgress?: (record: SourceRecord) => void;
  /**
   * Optional non-fatal warning channel. A connector that keeps going past a
   * recoverable problem (e.g. one of several Slack workspaces has no token, so
   * it is skipped while the rest sync — ADR-0014) emits a human-readable message
   * here instead of throwing. The sync service routes it to stderr; when absent
   * the connector simply has no place to report and stays silent.
   */
  readonly onWarn?: (message: string) => void;
}

/** A single observed source body produced by a connector (read-only). */
export interface SourceRecord {
  /** Cross-source-unique id assigned by the connector (workspace/team-prefixed as needed). */
  readonly externalId: string;
  /** Projection `source_type` (e.g. "github_issue"). */
  readonly sourceType: string;
  /** Extracted body text held locally (ADR-0003). */
  readonly body: string;
  /** When the source was observed at its origin (ISO 8601). */
  readonly observedAt: string;
  /** Connector-supplied metadata (JSON-serializable). */
  readonly meta: Record<string, unknown>;
  /**
   * Content fingerprint for delta detection (FR-ING-3). Optional: when omitted,
   * the sync service computes a SHA-256 over the body so every connector gets
   * change detection for free even without a delta API.
   */
  readonly fingerprint?: string;
  /**
   * Optional document-extraction handle (ADR-0024). When present **and** an
   * extractor is configured, the sync service replaces `body` with the sidecar's
   * extracted text for new/changed records (before fingerprint diff is recorded
   * and before embedding). Lazy: `readBytes` is only called when extraction will
   * actually run (not for unchanged records or when extraction is disabled), so
   * connectors attach it without paying the read cost up-front. Connectors that
   * produce no extractable binaries omit it; `body` then stays as set (e.g.
   * name-only). `fingerprint` is unaffected — it keys off the file entity
   * (e.g. local's `mtime:size`), so extraction never changes delta detection.
   */
  readonly extractable?: {
    /** Original filename, so the sidecar can dispatch by extension. */
    readonly filename: string;
    /** Byte size, so the sync service can skip oversized inputs (ADR-0024 §5). */
    readonly byteSize: number;
    /** Read the raw file bytes to send to the extractor (called at most once). */
    readBytes(): Promise<Uint8Array>;
  };
}

/** Outcome of one connector `sync` pass, returned to the sync service. */
export interface SyncResult {
  /**
   * Resume cursor to persist for the next run (delta APIs). `null` for
   * fingerprint-based connectors. Stored on `ConnectorSyncCompleted.cursor`.
   */
  readonly cursor: string | null;
  /**
   * Whether the pass completed with a *partial* failure: some internal sub-unit
   * (e.g. one of several Slack workspaces — ADR-0014) failed while the rest
   * succeeded, so the records that were collected are kept (the connector does
   * not throw, which would discard them) but the run is not a clean success.
   *
   * The sync service surfaces this on {@link SyncOutcome.partialFailure}; the CLI
   * treats it as a non-zero exit so a partial failure is not silently hidden
   * behind exit 0 in cron / CI (ADR-0027 exit-code parity, Issue #166). A
   * connector with no internal sub-units never sets it (`undefined` ⇒ no partial
   * failure).
   */
  readonly partialFailure?: boolean;
  /**
   * Optional human-readable summary lines for the pass (e.g. one per Slack
   * workspace: `acme=ok, beta=failed(cursor 保持), gamma=skipped`, ADR-0014).
   * The sync service forwards them on {@link SyncOutcome.summaryLines} so the CLI
   * can print a per-sub-unit breakdown after the counts. Omitted ⇒ nothing extra
   * to print (the counts line stands alone).
   */
  readonly summaryLines?: readonly string[];
}

/**
 * A read-only ingest source. `sync` streams observed source records; the sync
 * service (`./sync.ts`) diffs them against the `sources` projection and appends
 * events. Connectors never write back to the source (ADR-0003).
 */
export interface Connector {
  /** Stable connector name (CLI verb / config key), e.g. "github". */
  readonly name: string;
  /** Projection `source_type` family this connector produces (e.g. "github"). */
  readonly sourceType: string;
  /**
   * Stream observed source records (read-only). Heavy SDKs must be lazy-imported
   * inside this method to keep registration import-clean (ADR-0007).
   */
  sync(ctx: SyncContext): AsyncIterable<SourceRecord>;
  /**
   * Optional hook called once the stream is exhausted, returning the resume
   * cursor for the next run. Fingerprint-based connectors omit it (cursor `null`).
   */
  finalize?(): Promise<SyncResult> | SyncResult;
}

/**
 * Connector-specific config read from `[connectors.<name>]` (docs/design/config.md).
 * Left as an open record at the contract layer; each connector validates its
 * own slice with Zod.
 */
export type ConnectorConfig = Record<string, unknown>;

/** A factory that builds a connector from its config slice (lazy SDK inside). */
export type ConnectorFactory = (config: ConnectorConfig) => Connector;
