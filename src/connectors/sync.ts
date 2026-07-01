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
import { reconcileReadback, type SlackHomeColumns } from "../projections/task-readback.ts";
import type { Embedder } from "../retrieval/embedding/index.ts";
import { embedSources } from "../retrieval/embedding/index.ts";
import { authorFromMeta } from "./author.ts";
import { channelFromMeta } from "./channel.ts";
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
  /**
   * Whether the connector reported a partial failure: some internal sub-unit
   * (e.g. one Slack workspace, ADR-0014) failed while the rest succeeded. The
   * collected records are kept, but the CLI treats this as a non-zero exit so a
   * partial failure is not hidden behind exit 0 in cron / CI (ADR-0027, Issue
   * #166). `false` for a clean run / a connector with no sub-units.
   */
  partialFailure: boolean;
  /**
   * Optional per-sub-unit summary lines the connector emitted (e.g. one line per
   * Slack workspace, ADR-0014). The CLI prints these after the counts. Omitted
   * when the connector reported none.
   */
  summaryLines?: readonly string[];
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
  /**
   * `[tasks.home]` slack column/option mapping, so post-sync read-back can
   * interpret ingested `slack_list_item` raw cells (ADR-0036 §6). Omitted ⇒ Slack
   * read-back is skipped (GitHub/Jira read-back is config-free and still runs).
   */
  slackHome?: SlackHomeColumns | null;
}

/** Default cap when a caller supplies an extractor but no explicit max. */
const DEFAULT_EXTRACTION_MAX_BYTES = 5_000_000;

/**
 * Per-source extraction outcome recorded in `extraction_meta` (ADR-0024 §6).
 * `null` ⇒ no meta written (extractor absent, record not extractable, or a
 * transient failure that should be retried next sync).
 */
type ExtractionState = "extracted" | "unsupported" | "too_large" | null;

/**
 * Resolve the effective body for a record: the sidecar-extracted text when
 * extraction applies, else the connector's body (name-only). Best-effort — every
 * failure path returns the original body so ingest proceeds. `state` drives the
 * `extraction_meta` upsert (drift detection); `null` leaves meta untouched.
 */
async function extractBody(
  record: SourceRecord,
  options: SyncOptions,
): Promise<{ body: string; extracted: boolean; state: ExtractionState }> {
  const extractor = options.extractor;
  if (!extractor || !record.extractable)
    return { body: record.body, extracted: false, state: null };
  const maxBytes = options.extractionMaxBytes ?? DEFAULT_EXTRACTION_MAX_BYTES;
  const { filename, byteSize, readBytes } = record.extractable;
  if (byteSize > maxBytes) {
    options.onWarn?.(`extraction skipped (${byteSize} > ${maxBytes} bytes): ${filename}`);
    return { body: record.body, extracted: false, state: "too_large" };
  }
  try {
    const text = await extractor.extract(await readBytes(), filename);
    if (text === null) return { body: record.body, extracted: false, state: "unsupported" };
    const capped = text.length > maxBytes ? text.slice(0, maxBytes) : text;
    // Keep name discoverability (parity with text-file bodies: name + content).
    return { body: `${filename}\n\n${capped}`, extracted: true, state: "extracted" };
  } catch (cause) {
    options.onExtractError?.(cause instanceof Error ? cause : new Error(String(cause)));
    return { body: record.body, extracted: false, state: null }; // transient → retry
  }
}

/** Current `extraction_meta` version for a source, or `null` when never recorded. */
function extractionMetaVersion(sqlite: Database, externalId: string): string | null {
  const row = sqlite
    .query<{ version: string }, [string]>(
      "SELECT version FROM extraction_meta WHERE external_id = ?",
    )
    .get(externalId);
  return row ? row.version : null;
}

/** Upsert the extraction provenance for a source (derived substrate, ADR-0002). */
function upsertExtractionMeta(
  sqlite: Database,
  externalId: string,
  version: string,
  state: string,
  at: string,
): void {
  sqlite
    .query(
      `INSERT INTO extraction_meta (external_id, version, state, updated_at)
       VALUES ($id, $version, $state, $at)
       ON CONFLICT(external_id) DO UPDATE SET
         version = excluded.version, state = excluded.state, updated_at = excluded.updated_at`,
    )
    .run({ $id: externalId, $version: version, $state: state, $at: at });
}

/** Current stored body for a source, or `null` when absent. */
function existingBody(sqlite: Database, externalId: string): string | null {
  const row = sqlite
    .query<{ body: string }, [string]>("SELECT body FROM sources WHERE external_id = ?")
    .get(externalId);
  return row ? row.body : null;
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
  const now = options.now ?? (() => new Date());

  // Run-history bookkeeping (ADR-0033): record SyncRunStarted up front and
  // SyncRunEnded on every exit path (success, partial, throw) so the freshness
  // view (`sync status`) reflects failed runs too — something the success-only
  // ConnectorSyncCompleted event can never surface. runId is content-derived from
  // (connector, startedAt) so the start/end pair is stable and replay-safe.
  const startedAtDate = now();
  const startedAt = startedAtDate.toISOString();
  const runId = `${connector.name}:${startedAt}`;
  store.record(
    { type: "SyncRunStarted", connector: connector.name, runId, startedAt },
    startedAtDate,
  );

  try {
    const outcome = await runSyncPass(store, connector, options, now);
    store.record(
      {
        type: "SyncRunEnded",
        connector: connector.name,
        runId,
        status: outcome.partialFailure ? "partial" : "ok",
        observed: outcome.observed,
        updated: outcome.updated,
        unchanged: outcome.unchanged,
        durationMs: Math.max(0, now().getTime() - startedAtDate.getTime()),
      },
      now(),
    );
    return outcome;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    store.record(
      {
        type: "SyncRunEnded",
        connector: connector.name,
        runId,
        status: "error",
        durationMs: Math.max(0, now().getTime() - startedAtDate.getTime()),
        error: message,
      },
      now(),
    );
    throw cause;
  }
}

/**
 * Execute one ingest pass for a connector (the core delta-detection + recording
 * loop). Wrapped by {@link syncConnector}, which adds the SyncRunStarted /
 * SyncRunEnded run-history bookkeeping (ADR-0033) around it.
 */
async function runSyncPass(
  store: Store,
  connector: Connector,
  options: SyncOptions,
  now: () => Date,
): Promise<SyncOutcome> {
  const sqlite = store.connection.sqlite;
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
  // Channels already recorded this run (ADR-0037 §3): a connector yields one
  // record per message, so dedup by channel id to emit SlackChannelObserved at
  // most once per channel per run (the reducer is last-write-wins regardless).
  const seenChannels = new Set<string>();

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
            // Enrich the person projection with the sync-time-resolved display
            // name when the connector provided one (ADR-0037 §2/§4). Omitted when
            // resolution degraded — the reducer's last-write-wins keeps the prior
            // name and never overwrites it with an empty string (ADR-0037 §6).
            ...(author.displayName ? { displayName: author.displayName } : {}),
          },
          now(),
        );
      }

      // Resolve the channel this record belongs to → slack_channels projection
      // (ADR-0037 §3). The connector stashes the sync-time-resolved name / kind
      // into meta; here we fold it into a SlackChannelObserved once per channel
      // per run. Best-effort: a record with no channel concept (or a degrade
      // missing the id / kind / team) yields null and records nothing. On a
      // degrade the name is absent → the reducer keeps the prior resolved name
      // (last-write-wins with a non-empty guard, §6/§7).
      const channel = channelFromMeta(connector.name, record.meta);
      if (channel !== null && !seenChannels.has(channel.channelId)) {
        seenChannels.add(channel.channelId);
        store.record(
          {
            type: "SlackChannelObserved",
            channelId: channel.channelId,
            teamId: channel.teamId,
            kind: channel.kind,
            ...(channel.displayName ? { displayName: channel.displayName } : {}),
          },
          now(),
        );
      }
    }

    // Extraction drift (ADR-0024 §6): the file is unchanged (fingerprint match)
    // but it is extractable and the recorded extractor version differs (newly
    // enabled → no meta; or sidecar upgraded → version bump), so re-extract.
    const drifted =
      !!options.extractor &&
      record.extractable !== undefined &&
      extractionMetaVersion(sqlite, record.externalId) !== (options.extractor.version ?? "");

    if (prior === fingerprint && !drifted) {
      unchanged += 1;
      options.onProgress?.(record);
      continue;
    }

    // New / changed / drifted: run extraction (best-effort, before recording the
    // event so the stored body + embedding use the extracted text). fingerprint is
    // the file-entity hash above, unaffected by extraction (ADR-0024 §3/§6).
    const { body, extracted: didExtract, state } = await extractBody(record, options);
    if (didExtract) extracted += 1;
    // Record extraction provenance (drift detection) for deterministic outcomes;
    // a transient failure (state null) leaves meta absent so it retries next sync.
    if (state !== null && options.extractor) {
      upsertExtractionMeta(
        sqlite,
        record.externalId,
        options.extractor.version ?? "",
        state,
        now().toISOString(),
      );
    }

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
      toEmbed.push({ externalId: record.externalId, body });
    } else if (prior !== fingerprint) {
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
      toEmbed.push({ externalId: record.externalId, body });
    } else if (body !== existingBody(sqlite, record.externalId)) {
      // Drift-only (file unchanged) and the re-extracted body actually differs:
      // append a body update so search reflects it. If identical, the meta upsert
      // above is enough (no redundant event).
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
      toEmbed.push({ externalId: record.externalId, body });
    }

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

  // State read-back (ADR-0036 §6): reflect external state onto published tasks
  // whose home item was just (re)ingested. Read → local event only (no egress),
  // run after the full pass so all sources are folded. Diff-guarded inside.
  // `slackHome` lets it interpret `slack_list_item` raw cells (option C).
  reconcileReadback(store, now(), options.slackHome);

  return {
    connector: connector.name,
    observed,
    updated,
    unchanged,
    cursor: nextCursor,
    embedded,
    extracted,
    // Partial-failure flag (e.g. one Slack workspace failed, ADR-0014 / #166):
    // the records are kept, but the caller surfaces a non-zero exit so the
    // failure is not hidden behind exit 0. Connectors with no sub-units omit it.
    partialFailure: finalResult.partialFailure ?? false,
    ...(finalResult.summaryLines ? { summaryLines: finalResult.summaryLines } : {}),
  };
}
