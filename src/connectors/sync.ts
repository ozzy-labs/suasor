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
import type { Extractor } from "../extraction/index.ts";
import { personIdFor } from "../projections/person.ts";
import type { Embedder } from "../retrieval/embedding/index.ts";
import { embedSources } from "../retrieval/embedding/index.ts";
import { authorFromMeta } from "./author.ts";
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
  /**
   * Number of sources whose embedding was (re)populated into vec0 this run.
   * `0` when no embedder is configured (FTS-only), or when nothing changed.
   */
  embedded: number;
  /**
   * Number of sources whose body was replaced with sidecar-extracted text this
   * run (ADR-0024). `0` when no extractor is configured, or when no new/changed
   * record was extractable (or extraction degraded to name-only).
   */
  extracted: number;
}

export interface SyncOptions {
  /** Resume cursor from the previous run (defaults to the last persisted one). */
  cursor?: string | null;
  /** Secret-resolution backend (env + keychain). Injectable for tests. */
  secrets?: SecretStoreOptions;
  /** Progress sink for long-running syncs (forwarded to the connector). */
  onProgress?: (record: SourceRecord) => void;
  /** Non-fatal warning sink, forwarded to the connector as `ctx.onWarn`. */
  onWarn?: (message: string) => void;
  /** Clock injection for deterministic event timestamps in tests. */
  now?: () => Date;
  /**
   * Optional embedder (ADR-0005/0006). When supplied, new/changed source bodies
   * are embedded into the vec0 table for `recall.search`; document and query
   * embeddings therefore share one model. `null`/omitted keeps ingest FTS-only.
   * Embedding is best-effort: a sidecar failure is reported via `onEmbedError`
   * and does NOT fail the ingest (FTS still works — graceful degradation).
   */
  embedder?: Embedder | null;
  /** Called when embedding fails (best-effort populate; ingest still succeeds). */
  onEmbedError?: (error: Error) => void;
  /**
   * Optional document extractor (ADR-0024). When supplied, new/changed records
   * carrying an `extractable` handle have their body replaced with the sidecar's
   * extracted text (before the event is recorded and before embedding). Best-
   * effort: oversized inputs, unsupported formats, or extractor failures degrade
   * to the name-only body and do NOT fail ingest. `null`/omitted keeps Office/PDF
   * name-only.
   */
  extractor?: Extractor | null;
  /** Max bytes for both the input file and the stored extracted text (ADR-0024 §5). */
  extractionMaxBytes?: number;
  /** Called when extraction fails (best-effort; ingest still succeeds name-only). */
  onExtractError?: (error: Error) => void;
}

/** Default cap when a caller supplies an extractor but no explicit max. */
const DEFAULT_EXTRACTION_MAX_BYTES = 5_000_000;

/**
 * Resolve the effective body for a new/changed record: the sidecar-extracted
 * text when extraction applies, else the connector's body (name-only). Pure
 * best-effort — every failure path returns the original body so ingest proceeds.
 */
async function extractBody(
  record: SourceRecord,
  options: SyncOptions,
): Promise<{ body: string; extracted: boolean }> {
  const extractor = options.extractor;
  if (!extractor || !record.extractable) return { body: record.body, extracted: false };
  const maxBytes = options.extractionMaxBytes ?? DEFAULT_EXTRACTION_MAX_BYTES;
  const { filename, byteSize, readBytes } = record.extractable;
  if (byteSize > maxBytes) {
    options.onWarn?.(`extraction skipped (${byteSize} > ${maxBytes} bytes): ${filename}`);
    return { body: record.body, extracted: false };
  }
  try {
    const text = await extractor.extract(await readBytes(), filename);
    if (text === null) return { body: record.body, extracted: false }; // unsupported
    const capped = text.length > maxBytes ? text.slice(0, maxBytes) : text;
    // Keep name discoverability (parity with text-file bodies: name + content).
    return { body: `${filename}\n\n${capped}`, extracted: true };
  } catch (cause) {
    options.onExtractError?.(cause instanceof Error ? cause : new Error(String(cause)));
    return { body: record.body, extracted: false };
  }
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

  // The service is the single owner of per-record progress: it sees every
  // record, so it calls `options.onProgress` once per record below. We do NOT
  // also forward it via `ctx.onProgress`, which would double-fire the sink.
  const ctx: SyncContext = {
    cursor,
    secret: makeSecretResolver(connector.name, options.secrets),
    ...(options.onWarn ? { onWarn: options.onWarn } : {}),
  };

  let observed = 0;
  let updated = 0;
  let unchanged = 0;
  let extracted = 0;
  // Bodies whose vector needs (re)populating — new or changed sources only.
  // Unchanged sources keep their existing vector (fingerprint equality).
  const toEmbed: { externalId: string; body: string }[] = [];

  for await (const record of connector.sync(ctx)) {
    const fingerprint = record.fingerprint ?? (await sha256Hex(record.body));
    const prior = existingFingerprint(sqlite, record.externalId);

    // Resolve the author handle → person identity (ADR-0022). Best-effort: a
    // record with no author concept yields null and records no identity. The
    // reducer is idempotent on (connector, handle), so emitting on every
    // observed/updated record never duplicates or re-points an existing identity.
    if (prior === null || prior !== fingerprint) {
      const author = authorFromMeta(connector.name, record.meta);
      if (author !== null) {
        store.record(
          {
            type: "PersonIdentityObserved",
            personId: personIdFor(author.connector, author.handle),
            connector: author.connector,
            handle: author.handle,
          },
          now(),
        );
      }
    }

    if (prior === fingerprint) {
      unchanged += 1;
      options.onProgress?.(record);
      continue;
    }

    // New or changed: run extraction (best-effort, before recording the event so
    // the stored body + embedding use the extracted text). fingerprint is the
    // file-entity hash above, unaffected by extraction (ADR-0024 §3/§6).
    const { body, extracted: didExtract } = await extractBody(record, options);
    if (didExtract) extracted += 1;

    if (prior === null) {
      store.record(
        {
          type: "SourceObserved",
          externalId: record.externalId,
          sourceType: record.sourceType,
          body,
          observedAt: record.observedAt,
          fingerprint,
          meta: record.meta,
        },
        now(),
      );
      observed += 1;
    } else {
      store.record(
        {
          type: "SourceBodyUpdated",
          externalId: record.externalId,
          body,
          observedAt: record.observedAt,
          fingerprint,
          meta: record.meta,
        },
        now(),
      );
      updated += 1;
    }
    toEmbed.push({ externalId: record.externalId, body });

    options.onProgress?.(record);
  }

  // Embedding population (ADR-0005/0006). Best-effort: a sidecar failure is
  // reported but does not fail the ingest — FTS search still reflects the data,
  // and `recall.search` degrades gracefully until the vectors are present.
  let embedded = 0;
  if (options.embedder && toEmbed.length > 0) {
    const result = await embedSources(sqlite, options.embedder, toEmbed);
    embedded = result.embedded;
    if (result.error) options.onEmbedError?.(result.error);
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

  return {
    connector: connector.name,
    observed,
    updated,
    unchanged,
    cursor: nextCursor,
    embedded,
    extracted,
  };
}
