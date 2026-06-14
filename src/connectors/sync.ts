/**
 * Connector sync service — the shared ingest core (FR-ING-1..4, ADR-0007).
 *
 * Both `suasor <connector> sync` (CLI) and the `connector.sync` MCP write tool
 * (HITL, docs/design/mcp-surface.md) call **this same function**, so ingest
 * behaves identically regardless of entry point.
 *
 * For each record streamed by a connector:
 *  - compute a fingerprint (connector-supplied, else SHA-256 over the body),
 *  - compare against the `sources` projection (FR-ING-3 delta detection):
 *      - no existing row            → append `SourceObserved` (new),
 *      - row exists, fingerprint =  → skip (unchanged),
 *      - row exists, fingerprint ≠  → append `SourceBodyUpdated` (changed).
 *
 * A terminal `ConnectorSyncCompleted` records the resume cursor + counts. All
 * appends go through `Store.record`, which appends the event AND folds it into
 * the projections live (ADR-0002), so search reflects ingest immediately.
 *
 * The store layer (`bun:sqlite`) and connector SDKs are **not** imported at the
 * top level here — only the contract types — so importing this service stays
 * cheap. Callers pass an opened `Store`.
 */
import type { Database } from "bun:sqlite";
import type { Store } from "../db/index.ts";
import type { Connector, SourceRecord, SyncContext } from "./contract.ts";
import { makeSecretResolver, type SecretStoreOptions } from "./secrets.ts";

/** Per-run counters returned to the caller (CLI prints them; MCP returns them). */
export interface SyncOutcome {
  /** Connector that ran. */
  connector: string;
  /** New sources observed for the first time. */
  observed: number;
  /** Existing sources whose body changed (fingerprint differed). */
  updated: number;
  /** Existing sources skipped because the fingerprint was unchanged. */
  unchanged: number;
  /** Resume cursor persisted for the next run (`null` for fingerprint-based). */
  cursor: string | null;
}

export interface SyncOptions {
  /** Resume cursor from the previous run (defaults to the last persisted one). */
  cursor?: string | null;
  /** Secret-resolution backend (env + keychain). Injectable for tests. */
  secrets?: SecretStoreOptions;
  /** Progress sink for long-running syncs (forwarded to the connector). */
  onProgress?: (record: SourceRecord) => void;
  /** Clock injection for deterministic event timestamps in tests. */
  now?: () => Date;
}

/** Hex SHA-256 of a string (default fingerprint when a connector omits one). */
async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Read the stored fingerprint for a source, or `null` when it does not exist. */
function existingFingerprint(sqlite: Database, externalId: string): string | null {
  const row = sqlite
    .query<{ fingerprint: string }, [string]>(
      "SELECT fingerprint FROM sources WHERE external_id = ?",
    )
    .get(externalId);
  return row ? row.fingerprint : null;
}

/**
 * Read the resume cursor from the most recent `ConnectorSyncCompleted` event for
 * a connector. Returns `null` when the connector has never completed a run.
 *
 * Reads the event log directly (cursor is provenance that has no projection of
 * its own, by design — see reducer `ConnectorSyncCompleted`), newest first.
 */
export function lastCursor(sqlite: Database, connector: string): string | null {
  const rows = sqlite
    .query<{ payload: string }, []>(
      "SELECT payload FROM events WHERE type = 'ConnectorSyncCompleted' ORDER BY seq DESC",
    )
    .all();
  for (const row of rows) {
    const evt = JSON.parse(row.payload) as { connector?: string; cursor?: string | null };
    if (evt.connector === connector) return evt.cursor ?? null;
  }
  return null;
}

/**
 * Run one sync pass for a connector against an open store.
 *
 * Idempotent under fingerprint equality: re-running with no upstream change
 * observes 0 / updates 0 (records are skipped), while a terminal
 * `ConnectorSyncCompleted` is always appended to advance the cursor + provenance.
 */
export async function syncConnector(
  store: Store,
  connector: Connector,
  options: SyncOptions = {},
): Promise<SyncOutcome> {
  const sqlite = store.connection.sqlite;
  const now = options.now ?? (() => new Date());
  const cursor = options.cursor !== undefined ? options.cursor : lastCursor(sqlite, connector.name);

  const ctx: SyncContext = {
    cursor,
    secret: makeSecretResolver(connector.name, options.secrets),
    onProgress: options.onProgress,
  };

  let observed = 0;
  let updated = 0;
  let unchanged = 0;

  for await (const record of connector.sync(ctx)) {
    const fingerprint = record.fingerprint ?? (await sha256Hex(record.body));
    const prior = existingFingerprint(sqlite, record.externalId);

    if (prior === null) {
      store.record(
        {
          type: "SourceObserved",
          externalId: record.externalId,
          sourceType: record.sourceType,
          body: record.body,
          observedAt: record.observedAt,
          fingerprint,
          meta: record.meta,
        },
        now(),
      );
      observed += 1;
    } else if (prior === fingerprint) {
      unchanged += 1;
    } else {
      store.record(
        {
          type: "SourceBodyUpdated",
          externalId: record.externalId,
          body: record.body,
          observedAt: record.observedAt,
          fingerprint,
          meta: record.meta,
        },
        now(),
      );
      updated += 1;
    }

    options.onProgress?.(record);
  }

  const finalResult = connector.finalize ? await connector.finalize() : { cursor };
  const nextCursor = finalResult.cursor;

  store.record(
    {
      type: "ConnectorSyncCompleted",
      connector: connector.name,
      cursor: nextCursor,
      count: observed + updated,
    },
    now(),
  );

  return { connector: connector.name, observed, updated, unchanged, cursor: nextCursor };
}
