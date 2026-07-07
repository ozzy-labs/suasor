/**
 * Projection read queries backing the MCP read tools (ADR-0004, #8).
 *
 * Pure, side-effect-free SELECTs over the projection tables (`sources` /
 * `tasks` / `decisions` / `inbox` / `proposals` / `commitments` / `persons`)
 * that the MCP `source.list` / `source.get` / `task.list` / `decision.list` /
 * `inbox.list` / `propose.list` / `commitment.list` / `person.list` read tools
 * wrap. Read tools must have no side effects (ADR-0004
 * `read = destructive:false`), so every function here only reads.
 *
 * Time filters target each projection's natural timestamp column (the same
 * physical column the assistant skills filter on, docs/skills/README.md):
 *   - sources     → `observed_at`   (observed_after / observed_before)
 *   - tasks       → `updated_at`     (updated_after / updated_before)
 *   - decisions   → `recorded_at`    (recorded_after / recorded_before)
 *   - inbox       → `updated_at`     (updated_after / updated_before)
 *   - proposals   → `updated_at`     (updated_after / updated_before)
 *   - commitments → `updated_at`     (updated_after / updated_before)
 * Bounds are inclusive on the lower end and exclusive on the upper end so
 * adjacent ranges don't double-count, and compare ISO 8601 strings
 * lexicographically (valid because the stored timestamps are zero-padded UTC).
 */
import type { Database } from "bun:sqlite";
import { docsUrl } from "../shared/doc-ref.ts";

/** Default page size for the list queries (matches retrieval's default). */
export const DEFAULT_LIST_LIMIT = 50;

/**
 * Apply `search`'s truncation-transparency contract (ADR-0007 "no silent wrong
 * answer") to a `limit`-bounded list query. `fetch` runs the underlying query
 * with one extra row requested (`limit + 1`); if it comes back, the result was
 * cut off, so we drop the sentinel and report `truncated: true`. Returns the
 * trimmed rows plus a `truncated` boolean the caller folds into its response.
 *
 * `limit` is the *effective* cap (the tool's default when the arg is omitted).
 * Shared by the MCP read tools (`source.list` / `task.list` / … via
 * `server-read.ts`) and `buildBrief`'s per-section probe so both honour the
 * same contract.
 */
export function listWithTruncation<T>(
  limit: number,
  fetch: (probeLimit: number) => T[],
): { rows: T[]; truncated: boolean } {
  const rows = fetch(limit + 1);
  if (rows.length > limit) return { rows: rows.slice(0, limit), truncated: true };
  return { rows, truncated: false };
}

/** Inclusive-lower / exclusive-upper time window over an ISO 8601 column. */
export interface TimeRange {
  /** Inclusive lower bound (ISO 8601). */
  after?: string;
  /** Exclusive upper bound (ISO 8601). */
  before?: string;
}

/** Append a `column >= ? / column < ?` window to a WHERE clause builder. */
function pushTimeRange(
  clauses: string[],
  params: (string | number)[],
  column: string,
  range: TimeRange | undefined,
): void {
  if (range?.after !== undefined) {
    clauses.push(`${column} >= ?`);
    params.push(range.after);
  }
  if (range?.before !== undefined) {
    clauses.push(`${column} < ?`);
    params.push(range.before);
  }
}

/** A source row as exposed by the read tools (body included — held locally). */
export interface SourceRecord {
  externalId: string;
  sourceType: string;
  body: string;
  fingerprint: string;
  observedAt: string;
  /** Decoded connector metadata (stored as JSON). */
  meta: Record<string, unknown>;
}

interface SourceRow {
  external_id: string;
  source_type: string;
  body: string;
  fingerprint: string;
  observed_at: string;
  meta: string;
}

function parseMeta(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function toSourceRecord(row: SourceRow): SourceRecord {
  return {
    externalId: row.external_id,
    sourceType: row.source_type,
    body: row.body,
    fingerprint: row.fingerprint,
    observedAt: row.observed_at,
    meta: parseMeta(row.meta),
  };
}

export interface ListSourcesOptions {
  /** Restrict to a single `source_type` (e.g. "github_issue"). */
  sourceType?: string;
  /** Window over `observed_at`. */
  observed?: TimeRange;
  /** Max rows (default {@link DEFAULT_LIST_LIMIT}). */
  limit?: number;
}

/** List sources newest-first (`observed_at` DESC), optionally filtered. */
export function listSources(sqlite: Database, options: ListSourcesOptions = {}): SourceRecord[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (options.sourceType !== undefined) {
    clauses.push("source_type = ?");
    params.push(options.sourceType);
  }
  pushTimeRange(clauses, params, "observed_at", options.observed);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(options.limit ?? DEFAULT_LIST_LIMIT);
  const rows = sqlite
    .query<SourceRow, (string | number)[]>(
      `SELECT external_id, source_type, body, fingerprint, observed_at, meta
         FROM sources
         ${where}
        ORDER BY observed_at DESC
        LIMIT ?`,
    )
    .all(...params);
  return rows.map(toSourceRecord);
}

/** Fetch a single source by `external_id`, or `null` when absent. */
export function getSource(sqlite: Database, externalId: string): SourceRecord | null {
  const row = sqlite
    .query<SourceRow, [string]>(
      `SELECT external_id, source_type, body, fingerprint, observed_at, meta
         FROM sources
        WHERE external_id = ?`,
    )
    .get(externalId);
  return row ? toSourceRecord(row) : null;
}

/** A source's document-extraction provenance sidecar row (ADR-0024). */
export interface ExtractionMetaRecord {
  /** Extractor version that produced the extracted body (drift detection). */
  version: string;
  /** Per-source outcome: extracted / unsupported / too_large (src/connectors/sync.ts). */
  state: string;
  /** When the extraction meta row was last updated (ISO 8601). */
  updatedAt: string;
}

interface ExtractionMetaRow {
  version: string;
  state: string;
  updated_at: string;
}

/**
 * Fetch a source's `extraction_meta` sidecar row (ADR-0024), or `null` when the
 * source was never extracted (e.g. a plain-text connector body). Pure SELECT.
 */
export function getExtractionMeta(
  sqlite: Database,
  externalId: string,
): ExtractionMetaRecord | null {
  const row = sqlite
    .query<ExtractionMetaRow, [string]>(
      "SELECT version, state, updated_at FROM extraction_meta WHERE external_id = ?",
    )
    .get(externalId);
  return row ? { version: row.version, state: row.state, updatedAt: row.updated_at } : null;
}

/**
 * A source's full bundle for `source.get.full` (Issue #279): the source record
 * (metadata + body), its outgoing provenance links, and its extraction-meta
 * sidecar — what otherwise needs `source.get` + `graph.related(out)` + an
 * extraction query in three round-trips, returned in one. `source` is `null`
 * when the id is unknown (then links/extractionMeta are empty/null too).
 */
export interface SourceFull {
  source: SourceRecord | null;
  /** Outgoing provenance neighbours (origin is the link's `from`). */
  links: GraphNeighbor[];
  /** Document-extraction provenance, or `null` when never extracted (ADR-0024). */
  extractionMeta: ExtractionMetaRecord | null;
}

/**
 * Bundle a source's metadata + body, its outgoing provenance links, and its
 * extraction-meta sidecar in one call (`source.get.full`, Issue #279). Reuses
 * the existing query layer (`getSource` + `listLinks(direction=out)` +
 * `getExtractionMeta`); a graph entity is addressed as `(kind=source, id=externalId)`.
 * Pure SELECTs (read-only). An unknown id returns `{ source: null, links: [],
 * extractionMeta: null }`.
 */
export function getSourceFull(sqlite: Database, externalId: string): SourceFull {
  const source = getSource(sqlite, externalId);
  if (source === null) return { source: null, links: [], extractionMeta: null };
  return {
    source,
    links: listLinks(sqlite, "source", externalId, { direction: "out" }),
    extractionMeta: getExtractionMeta(sqlite, externalId),
  };
}

/** Latest sync run for a connector, as exposed to `sync status` (ADR-0033). */
export interface SyncRunRecord {
  connector: string;
  /** Id of the latest run (`<connector>:<startedAt>`). */
  runId: string;
  /** When the latest run started (ISO 8601). */
  startedAt: string;
  /** When the latest run ended (ISO 8601); null while still running. */
  endedAt: string | null;
  /** running / ok / partial / error. */
  status: string;
  observed: number;
  updated: number;
  unchanged: number;
  /** Wall-clock duration in ms; null while still running. */
  durationMs: number | null;
  /** Failure message when status = error; null otherwise. */
  lastError: string | null;
}

interface SyncRunRow {
  connector: string;
  run_id: string;
  started_at: string;
  ended_at: string | null;
  status: string;
  observed: number;
  updated: number;
  unchanged: number;
  duration_ms: number | null;
  last_error: string | null;
}

/**
 * List the latest sync run per connector (ADR-0033), most recently ended first
 * (still-running / never-ended rows sort last). Read-only — backs
 * `suasor sync status`. Returns one row per connector that has ever synced.
 */
export function listSyncRuns(sqlite: Database): SyncRunRecord[] {
  const rows = sqlite
    .query<SyncRunRow, []>(
      `SELECT connector, run_id, started_at, ended_at, status,
              observed, updated, unchanged, duration_ms, last_error
         FROM sync_runs
        ORDER BY COALESCE(ended_at, started_at) DESC, connector ASC`,
    )
    .all();
  return rows.map((r) => ({
    connector: r.connector,
    runId: r.run_id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    status: r.status,
    observed: r.observed,
    updated: r.updated,
    unchanged: r.unchanged,
    durationMs: r.duration_ms,
    lastError: r.last_error,
  }));
}

/** One version of a source's body, reconstructed from the event log. */
export interface SourceVersion {
  /** When the source was observed at its origin (ISO 8601). */
  observedAt: string;
  /** Content fingerprint at this version. */
  fingerprint: string;
  /** Full body text at this version (events retain every version, ADR-0002). */
  body: string;
  /** When this version's event was appended (ISO 8601). */
  recordedAt: string;
}

interface EventBodyRow {
  recorded_at: string;
  payload: string;
}

/**
 * List a source's body versions from the event log, newest first.
 *
 * Unlike `getSource` (which reads the projection's current body only), this
 * reconstructs the full history from the append-only `events` table:
 * `SourceObserved` and `SourceBodyUpdated` both carry the complete body
 * (src/events/types.ts), so a true before/after diff is possible. Side-effect
 * free (a SELECT over `events`), backing the `source.history` read tool (#121).
 */
export function listSourceHistory(
  sqlite: Database,
  externalId: string,
  options: { limit?: number } = {},
): SourceVersion[] {
  const rows = sqlite
    .query<EventBodyRow, [string, number]>(
      `SELECT recorded_at, payload
         FROM events
        WHERE type IN ('SourceObserved', 'SourceBodyUpdated')
          AND json_extract(payload, '$.externalId') = ?
        ORDER BY recorded_at DESC
        LIMIT ?`,
    )
    .all(externalId, options.limit ?? DEFAULT_LIST_LIMIT);
  return rows.map((row) => {
    const payload = JSON.parse(row.payload) as {
      observedAt: string;
      fingerprint: string;
      body: string;
    };
    return {
      observedAt: payload.observedAt,
      fingerprint: payload.fingerprint,
      body: payload.body,
      recordedAt: row.recorded_at,
    };
  });
}

/** A task projection row, with the read-time-derived `overdue` flag (ADR-0028). */
export interface TaskRecord {
  id: string;
  title: string;
  state: string;
  /** Optional due date (ISO 8601); null when the task has none (ADR-0028). */
  dueDate: string | null;
  /** Optional priority (low/normal/high); null when unprioritised (ADR-0028). */
  priority: string | null;
  /**
   * Derived at read time (NOT stored — ADR-0028): the task has a `dueDate` in the
   * past relative to `now` and is still actionable (state ∈ {open, in_progress}).
   * Current-time state must not be folded into a replay-stable projection.
   */
  overdue: boolean;
  createdAt: string;
  updatedAt: string;
}

interface TaskRow {
  id: string;
  title: string;
  state: string;
  due_date: string | null;
  priority: string | null;
  created_at: string;
  updated_at: string;
}

/** Lifecycle states for which an overdue task is still actionable (ADR-0028). */
const OVERDUE_ACTIVE_STATES = new Set(["open", "in_progress"]);

/** Derive overdue (read-time, ADR-0028): past due AND still actionable. */
function isOverdue(dueDate: string | null, state: string, now: string): boolean {
  return dueDate !== null && dueDate < now && OVERDUE_ACTIVE_STATES.has(state);
}

export interface ListTasksOptions {
  /** Restrict to a lifecycle state (proposed/open/in_progress/completed/dropped). */
  state?: string;
  /** Window over `updated_at`. */
  updated?: TimeRange;
  /** Keep only tasks with `due_date < dueBefore` (ISO 8601, ADR-0028). */
  dueBefore?: string;
  /**
   * Keep only tasks due within the next N days of `now` (`due_date < now + N
   * days`, ADR-0028). The "今日/今週の優先" surface: `dueWithinDays: 7` is the
   * coming week. Like `dueBefore`, null-due tasks are excluded. The boundary is
   * derived from the same injectable `now` as `overdue`, so it is deterministic
   * under test. Combine with `state: "open"` to scope to actionable work.
   */
  dueWithinDays?: number;
  /** Keep only overdue tasks (read-time derived: past due AND active, ADR-0028). */
  overdue?: boolean;
  /**
   * Reference "now" for the overdue derivation (ISO 8601). Injectable so the
   * overdue boundary is deterministic under test (ADR-0028); defaults to the
   * current wall clock.
   */
  now?: string;
  limit?: number;
}

/**
 * List tasks most-recently-updated first. `overdue` is derived per row at read
 * time (ADR-0028) from `dueBefore`-comparable `now`, never stored. When
 * `overdue: true` is requested the rows are post-filtered after the SELECT (the
 * derivation is not a SQL column), so the limit is applied to the filtered set.
 */
export function listTasks(sqlite: Database, options: ListTasksOptions = {}): TaskRecord[] {
  const now = options.now ?? new Date().toISOString();
  const limit = options.limit ?? DEFAULT_LIST_LIMIT;
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (options.state !== undefined) {
    clauses.push("state = ?");
    params.push(options.state);
  }
  if (options.dueBefore !== undefined) {
    clauses.push("due_date IS NOT NULL AND due_date < ?");
    params.push(options.dueBefore);
  }
  if (options.dueWithinDays !== undefined) {
    // Derive the upper bound from the same `now` as overdue so the "due soon"
    // window is deterministic under test (ADR-0028). Null-due tasks are excluded.
    const horizon = new Date(
      new Date(now).getTime() + options.dueWithinDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    clauses.push("due_date IS NOT NULL AND due_date < ?");
    params.push(horizon);
  }
  pushTimeRange(clauses, params, "updated_at", options.updated);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  // overdue is a read-time derivation, not a column: when filtering by it, defer
  // the LIMIT to the post-filter step so it isn't truncated before the filter.
  const sqlLimit = options.overdue === true ? Number.MAX_SAFE_INTEGER : limit;
  params.push(sqlLimit);
  const rows = sqlite
    .query<TaskRow, (string | number)[]>(
      `SELECT id, title, state, due_date, priority, created_at, updated_at
         FROM tasks
         ${where}
        ORDER BY updated_at DESC
        LIMIT ?`,
    )
    .all(...params);
  let records = rows.map((r) => ({
    id: r.id,
    title: r.title,
    state: r.state,
    dueDate: r.due_date,
    priority: r.priority,
    overdue: isOverdue(r.due_date, r.state, now),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
  if (options.overdue === true) {
    records = records.filter((r) => r.overdue).slice(0, limit);
  }
  return records;
}

/** A decision projection row. */
export interface DecisionRecord {
  id: string;
  title: string;
  rationale: string;
  recordedAt: string;
}

interface DecisionRow {
  id: string;
  title: string;
  rationale: string;
  recorded_at: string;
}

export interface ListDecisionsOptions {
  /** Window over `recorded_at`. */
  recorded?: TimeRange;
  limit?: number;
}

/** List decisions most-recently-recorded first. */
export function listDecisions(
  sqlite: Database,
  options: ListDecisionsOptions = {},
): DecisionRecord[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  pushTimeRange(clauses, params, "recorded_at", options.recorded);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(options.limit ?? DEFAULT_LIST_LIMIT);
  const rows = sqlite
    .query<DecisionRow, (string | number)[]>(
      `SELECT id, title, rationale, recorded_at
         FROM decisions
         ${where}
        ORDER BY recorded_at DESC
        LIMIT ?`,
    )
    .all(...params);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    rationale: r.rationale,
    recordedAt: r.recorded_at,
  }));
}

/** An inbox projection row. */
export interface InboxRecord {
  id: string;
  sourceExternalId: string;
  state: string;
  updatedAt: string;
}

interface InboxRow {
  id: string;
  source_external_id: string;
  state: string;
  updated_at: string;
}

export interface ListInboxOptions {
  /** Restrict to a triage state (open/snoozed/done/dismissed). */
  state?: string;
  /**
   * Restrict to items whose underlying source has this `source_type` (e.g.
   * "slack_message"). The inbox projection stores only `source_external_id`, so
   * this joins against `sources` to resolve the type — "only Slack in my inbox".
   */
  sourceType?: string;
  /** Window over `updated_at`. */
  updated?: TimeRange;
  limit?: number;
}

/** List inbox items most-recently-updated first. */
export function listInbox(sqlite: Database, options: ListInboxOptions = {}): InboxRecord[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (options.state !== undefined) {
    clauses.push("inbox.state = ?");
    params.push(options.state);
  }
  // The inbox table has no source_type column; join sources to filter by it.
  const join =
    options.sourceType !== undefined
      ? "JOIN sources ON sources.external_id = inbox.source_external_id"
      : "";
  if (options.sourceType !== undefined) {
    clauses.push("sources.source_type = ?");
    params.push(options.sourceType);
  }
  pushTimeRange(clauses, params, "inbox.updated_at", options.updated);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(options.limit ?? DEFAULT_LIST_LIMIT);
  const rows = sqlite
    .query<InboxRow, (string | number)[]>(
      `SELECT inbox.id, inbox.source_external_id, inbox.state, inbox.updated_at
         FROM inbox
         ${join}
         ${where}
        ORDER BY inbox.updated_at DESC
        LIMIT ?`,
    )
    .all(...params);
  return rows.map((r) => ({
    id: r.id,
    sourceExternalId: r.source_external_id,
    state: r.state,
    updatedAt: r.updated_at,
  }));
}

/** A proposal lifecycle ledger row (Issue #89). */
export interface ProposalRecord {
  candidateId: string;
  mode: string;
  kind: string;
  /**
   * Target entity id: the planned (base) id while pending; once `applied`,
   * the actually minted id (task/decision may carry a `-N` suffix, #435).
   */
  entityId: string;
  summary: string;
  /** Lifecycle state: pending / applied / rejected. */
  state: string;
  /** Rejection reason (empty unless state = rejected). */
  reason: string;
  createdAt: string;
  updatedAt: string;
}

interface ProposalRow {
  candidate_id: string;
  mode: string;
  kind: string;
  entity_id: string;
  summary: string;
  state: string;
  reason: string;
  created_at: string;
  updated_at: string;
}

export interface ListProposalsOptions {
  /** Restrict to a lifecycle state (pending / applied / rejected). */
  state?: string;
  /** Restrict to a candidate kind (task / decision / reply_draft / triage). */
  kind?: string;
  /** Window over `updated_at`. */
  updated?: TimeRange;
  limit?: number;
}

/**
 * List proposal candidates most-recently-updated first, optionally filtered by
 * lifecycle state (pending/applied/rejected) and kind. Backs `propose.list` —
 * the read half of the HITL approve/reject loop (Issue #89). Pure SELECT.
 */
export function listProposals(
  sqlite: Database,
  options: ListProposalsOptions = {},
): ProposalRecord[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (options.state !== undefined) {
    clauses.push("state = ?");
    params.push(options.state);
  }
  if (options.kind !== undefined) {
    clauses.push("kind = ?");
    params.push(options.kind);
  }
  pushTimeRange(clauses, params, "updated_at", options.updated);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(options.limit ?? DEFAULT_LIST_LIMIT);
  const rows = sqlite
    .query<ProposalRow, (string | number)[]>(
      `SELECT candidate_id, mode, kind, entity_id, summary, state, reason, created_at, updated_at
         FROM proposals
         ${where}
        ORDER BY updated_at DESC
        LIMIT ?`,
    )
    .all(...params);
  return rows.map((r) => ({
    candidateId: r.candidate_id,
    mode: r.mode,
    kind: r.kind,
    entityId: r.entity_id,
    summary: r.summary,
    state: r.state,
    reason: r.reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

/** A commitment ledger row (ADR-0021). */
export interface CommitmentRecord {
  id: string;
  title: string;
  /** Who owes whom: "owed_by_me" / "owed_to_me". */
  direction: string;
  /** Lifecycle state: open / resolved / dismissed. */
  state: string;
  /** Optional due date (ISO 8601); null when the commitment has none. */
  dueDate: string | null;
  /** Optional related person; null when unknown. */
  person: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CommitmentRow {
  id: string;
  title: string;
  direction: string;
  state: string;
  due_date: string | null;
  person: string | null;
  created_at: string;
  updated_at: string;
}

export interface ListCommitmentsOptions {
  /** Restrict to a lifecycle state (open / resolved / dismissed). */
  state?: string;
  /** Restrict to a direction (owed_by_me / owed_to_me). */
  direction?: string;
  /** Restrict to a related person (exact match on the stored `person`, ADR-0021). */
  person?: string;
  /** Window over `updated_at`. */
  updated?: TimeRange;
  limit?: number;
}

/**
 * List commitments most-recently-updated first, optionally filtered by lifecycle
 * state (open/resolved/dismissed), direction (owed_by_me/owed_to_me), and the
 * related `person` (exact match — "誰との約束か" for chasing a specific person).
 * Backs
 * `commitment.list` — the read half of the commitment ledger (ADR-0021), so
 * `brief` / `next-actions` skills can surface "やるべきこと" alongside demand.
 * Pure SELECT.
 */
export function listCommitments(
  sqlite: Database,
  options: ListCommitmentsOptions = {},
): CommitmentRecord[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (options.state !== undefined) {
    clauses.push("state = ?");
    params.push(options.state);
  }
  if (options.direction !== undefined) {
    clauses.push("direction = ?");
    params.push(options.direction);
  }
  if (options.person !== undefined) {
    clauses.push("person = ?");
    params.push(options.person);
  }
  pushTimeRange(clauses, params, "updated_at", options.updated);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(options.limit ?? DEFAULT_LIST_LIMIT);
  const rows = sqlite
    .query<CommitmentRow, (string | number)[]>(
      `SELECT id, title, direction, state, due_date, person, created_at, updated_at
         FROM commitments
         ${where}
        ORDER BY updated_at DESC
        LIMIT ?`,
    )
    .all(...params);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    direction: r.direction,
    state: r.state,
    dueDate: r.due_date,
    person: r.person,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

/** Connector-neutral demand source grouping (ADR-0041). */
export type DemandSource = "slack" | "github";

/**
 * Seen-state of a demand row (ADR-0041). `acked` / `dismissed` come from the
 * local `demand_seen` projection (a `demand.ack` / `demand.dismiss` event);
 * `read` is derived for a `github_notification` whose ingested `meta.unread` is
 * `false` (already read on GitHub). `null` = outstanding (un-acked) — the only
 * rows `demand.list` returns by default.
 */
export type DemandSeenState = "acked" | "dismissed" | "read";

/**
 * `github_notification` `reason`s that count as demand — "requires your
 * attention" (ADR-0041). GitHub emits many reasons; only these five carry a
 * "you should act" signal (the rest — `subscribed` / `ci_activity` / `push` /
 * `state_change` / … — are FYI noise that would drown the triage tier):
 *   - `review_requested` — a review was requested from you
 *   - `mention` / `team_mention` — you (or your team) were @mentioned
 *   - `assign` — an issue/PR was assigned to you
 *   - `author` — you authored the thread and there is new activity to answer
 * Exported + tested so the demand-worthy set is discoverable and adjustable
 * without spelunking the query. The neutral demand `kind` for a github row is its
 * `reason` verbatim.
 */
export const GITHUB_DEMAND_REASONS = [
  "assign",
  "author",
  "mention",
  "review_requested",
  "team_mention",
] as const;

/**
 * A connector-neutral demand signal (ADR-0041): an attention-worthy row derived
 * (FTS-first, no extra fetch) from ingested sources — a Slack `@you` mention / DM
 * (ADR-0012) or a `github_notification` thread. Generalises the former
 * Slack-only `SlackDemandRecord`.
 */
export interface DemandRecord extends SourceRecord {
  /** Which connector the demand came from (`slack` / `github`). */
  source: DemandSource;
  /**
   * Fine-grained classification: Slack `mention` / `dm`, or a github
   * notification `reason` (e.g. `review_requested`).
   */
  kind: string;
  /**
   * Human-readable channel name joined from the local `slack_channels`
   * projection (ADR-0037 §3/§10) via `meta.channel`. `null` for github rows or
   * when unresolved (fall back to the raw id in `meta.channel`). Never
   * live-fetched (no-fetch-at-query, ADR-0012).
   */
  channelName: string | null;
  /**
   * Sender display name joined from the local `person_identities` projection
   * (ADR-0022 / ADR-0037 §2/§10) via `meta.user` (`identity_key = 'slack:'||user`).
   * `null` for github rows or when unresolved. Never live-fetched.
   */
  userName: string | null;
  /**
   * Workspace display name joined from the local `slack_teams` projection
   * (ADR-0037 §3/§10, Issue #361) via `meta.team`. `null` for github rows or
   * when unresolved. Never live-fetched (no-fetch-at-query, ADR-0012).
   */
  teamName: string | null;
  /**
   * Seen-state (ADR-0041): `acked` / `dismissed` from `demand_seen`, or `read`
   * for a github notification with `meta.unread === false`. `null` = outstanding.
   * Only present when `includeSeen` is set (the default view returns un-acked
   * rows, for which this is always `null`).
   */
  seenState: DemandSeenState | null;
}

export interface ListDemandOptions {
  /** Operator user ids (`Uxxxx`) for Slack `<@you>` mention detection (ADR-0012). */
  selfUserIds?: string[];
  /** Restrict to a single connector (`slack` / `github`); default: both. */
  source?: DemandSource;
  /**
   * Restrict to these kinds (matched against `kind`: Slack `mention` / `dm`, or a
   * github `reason`). Default: every demand kind.
   */
  kinds?: string[];
  /** Window over `observed_at`. */
  observed?: TimeRange;
  /**
   * Include seen rows too (acked / dismissed / github-read). Default `false` —
   * only outstanding (un-acked) demand is returned, so "unprocessed" is true
   * (ADR-0041, superseding ADR-0012 決定 4's host-side seen-marker).
   */
  includeSeen?: boolean;
  /** Max rows (default {@link DEFAULT_LIST_LIMIT}). */
  limit?: number;
}

/** A `slack_message` source id is a DM when its channel id starts with `D`. */
const DM_CHANNEL_CLAUSE = "json_extract(sources.meta, '$.channel') LIKE 'D%'";

/** A demand source row plus its locally-joined channel / sender / team names. */
interface DemandRow extends SourceRow {
  source: DemandSource;
  kind: string;
  channel_name: string | null;
  user_name: string | null;
  team_name: string | null;
  seen_state: string | null;
}

/** Empty / absent joined name → `null` (id-only fallback, ADR-0037 §6). */
function nameOrNull(value: string | null): string | null {
  return value !== null && value !== "" ? value : null;
}

/**
 * List connector-neutral demand (ADR-0041) — attention-worthy rows derived
 * (FTS-first, no extra fetch) from ingested sources, newest-first:
 *   - **Slack** (`source: "slack"`): `@you` mentions (need `selfUserIds`) and DMs
 *     (channel id starts with `D`), classified `kind: "mention" | "dm"`
 *     (ADR-0012). Enriched with `channelName` / `userName` / `teamName` via LEFT
 *     JOINs to the local `slack_channels` / `person_identities` / `slack_teams`
 *     projections (ADR-0037 §10) — a pure local join, no Slack API at query time.
 *   - **GitHub** (`source: "github"`): `github_notification` threads whose
 *     `meta.reason` is demand-worthy ({@link GITHUB_DEMAND_REASONS}); `kind` is
 *     the reason (e.g. `review_requested`). No slack enrichment (those are null).
 *
 * By default only **outstanding** (un-acked) demand is returned: rows with a
 * `demand_seen` marker (`demand.ack` / `demand.dismiss`, ADR-0041) — or a github
 * notification already read on GitHub (`meta.unread === false`) — are hidden. Set
 * `includeSeen` to return everything with `seenState` populated. This is what
 * makes "unprocessed" true (ADR-0012 決定 4's host-side seen-marker is superseded;
 * the state now lives in the event log, ADR-0002). Pure SELECT.
 */
export function listDemand(sqlite: Database, options: ListDemandOptions = {}): DemandRecord[] {
  const selfUserIds = options.selfUserIds ?? [];
  const kinds = options.kinds;
  const branches: string[] = [];
  const branchParams: string[] = [];

  // Slack branch: DM and/or @mention predicates (gated by `kinds` + selfUserIds).
  if (options.source !== "github") {
    const wantsDm = kinds === undefined || kinds.includes("dm");
    const wantsMention = kinds === undefined || kinds.includes("mention");
    const orClauses: string[] = [];
    if (wantsDm) orClauses.push(DM_CHANNEL_CLAUSE);
    if (wantsMention) {
      for (const uid of selfUserIds) {
        orClauses.push("sources.body LIKE ?");
        branchParams.push(`%<@${uid}>%`);
      }
    }
    if (orClauses.length > 0) {
      branches.push(
        `SELECT sources.external_id, sources.source_type, sources.body, sources.fingerprint,
                sources.observed_at, sources.meta,
                'slack' AS source,
                CASE WHEN ${DM_CHANNEL_CLAUSE} THEN 'dm' ELSE 'mention' END AS kind,
                slack_channels.name AS channel_name,
                person_identities.display_name AS user_name,
                slack_teams.name AS team_name
           FROM sources
           LEFT JOIN slack_channels
             ON slack_channels.channel_id = json_extract(sources.meta, '$.channel')
           LEFT JOIN person_identities
             ON person_identities.identity_key = 'slack:' || json_extract(sources.meta, '$.user')
           LEFT JOIN slack_teams
             ON slack_teams.team_id = json_extract(sources.meta, '$.team')
          WHERE sources.source_type = 'slack_message' AND (${orClauses.join(" OR ")})`,
      );
    }
  }

  // GitHub branch: notification threads whose reason is demand-worthy (and, when
  // `kinds` is set, intersected with it). No slack name enrichment (NULLs align
  // the UNION columns).
  if (options.source !== "slack") {
    const reasons =
      kinds === undefined
        ? [...GITHUB_DEMAND_REASONS]
        : GITHUB_DEMAND_REASONS.filter((r) => kinds.includes(r));
    if (reasons.length > 0) {
      const placeholders = reasons.map(() => "?").join(", ");
      branches.push(
        `SELECT sources.external_id, sources.source_type, sources.body, sources.fingerprint,
                sources.observed_at, sources.meta,
                'github' AS source,
                json_extract(sources.meta, '$.reason') AS kind,
                NULL AS channel_name, NULL AS user_name, NULL AS team_name
           FROM sources
          WHERE sources.source_type = 'github_notification'
            AND json_extract(sources.meta, '$.reason') IN (${placeholders})`,
      );
      branchParams.push(...reasons);
    }
  }

  // No applicable predicate (e.g. slack mention-only with no self ids, or a
  // `kinds` filter that matches nothing) → no demand.
  if (branches.length === 0) return [];

  const outer: string[] = [];
  const outerParams: (string | number)[] = [];
  pushTimeRange(outer, outerParams, "d.observed_at", options.observed);
  if (!options.includeSeen) {
    // Outstanding = no local seen marker AND not a github-read notification. Done
    // in SQL (not post-filter) so `limit` counts un-acked rows, not seen ones.
    // A github notification is "read" only when `unread` is explicitly false
    // (`= 0`); a null/absent `unread` stays outstanding. `IS NOT 0` is null-safe,
    // so a NULL unread does NOT collapse the whole predicate to NULL (which would
    // wrongly hide the row).
    outer.push("ds.state IS NULL");
    outer.push(
      "(d.source_type <> 'github_notification' OR json_extract(d.meta, '$.unread') IS NOT 0)",
    );
  }
  const where = outer.length > 0 ? `WHERE ${outer.join(" AND ")}` : "";
  const params: (string | number)[] = [
    ...branchParams,
    ...outerParams,
    options.limit ?? DEFAULT_LIST_LIMIT,
  ];

  const rows = sqlite
    .query<DemandRow, (string | number)[]>(
      `SELECT d.external_id, d.source_type, d.body, d.fingerprint, d.observed_at, d.meta,
              d.source, d.kind, d.channel_name, d.user_name, d.team_name,
              ds.state AS seen_state
         FROM (${branches.join(" UNION ALL ")}) AS d
         LEFT JOIN demand_seen ds ON ds.external_id = d.external_id
        ${where}
        ORDER BY d.observed_at DESC, d.external_id DESC
        LIMIT ?`,
    )
    .all(...params);

  return rows.map((row) => {
    const record = toSourceRecord(row);
    const source = row.source;
    let seenState: DemandSeenState | null = null;
    if (row.seen_state === "acked" || row.seen_state === "dismissed") {
      seenState = row.seen_state;
    } else if (source === "github" && record.meta.unread === false) {
      seenState = "read";
    }
    return {
      ...record,
      source,
      kind: row.kind,
      channelName: nameOrNull(row.channel_name),
      userName: nameOrNull(row.user_name),
      teamName: nameOrNull(row.team_name),
      seenState,
    };
  });
}

/** One connector identity bound to a person (ADR-0022). */
export interface PersonIdentityRecord {
  connector: string;
  handle: string;
  displayName: string;
  observedAt: string;
}

/** A resolved person with its connector identities (ADR-0022). */
export interface PersonRecord {
  id: string;
  displayName: string;
  identityCount: number;
  createdAt: string;
  updatedAt: string;
  /** The `(connector, handle)` identities currently resolving to this person. */
  identities: PersonIdentityRecord[];
}

interface PersonRow {
  id: string;
  display_name: string;
  identity_count: number;
  created_at: string;
  updated_at: string;
}

interface PersonIdentityRow {
  person_id: string;
  connector: string;
  handle: string;
  display_name: string;
  observed_at: string;
}

export interface ListPersonsOptions {
  /**
   * Include persons with no identities (emptied by a merge). Default `false` —
   * `person.list` surfaces resolvable people, not merge tombstones.
   */
  includeEmpty?: boolean;
  /** Max rows (default {@link DEFAULT_LIST_LIMIT}). */
  limit?: number;
}

/**
 * List resolved persons most-recently-updated first, each with its connector
 * identities attached (ADR-0022). Emptied persons (a merge moved all their
 * identities away) are hidden unless `includeEmpty` is set.
 */
export function listPersons(sqlite: Database, options: ListPersonsOptions = {}): PersonRecord[] {
  const where = options.includeEmpty ? "" : "WHERE identity_count > 0";
  const limit = options.limit ?? DEFAULT_LIST_LIMIT;
  const persons = sqlite
    .query<PersonRow, [number]>(
      `SELECT id, display_name, identity_count, created_at, updated_at
         FROM persons
         ${where}
        ORDER BY updated_at DESC
        LIMIT ?`,
    )
    .all(limit);
  if (persons.length === 0) return [];

  // Fetch identities for the returned persons in one pass, then group by person.
  const ids = persons.map((p) => p.id);
  const placeholders = ids.map(() => "?").join(", ");
  const identityRows = sqlite
    .query<PersonIdentityRow, string[]>(
      `SELECT person_id, connector, handle, display_name, observed_at
         FROM person_identities
        WHERE person_id IN (${placeholders})
        ORDER BY connector ASC, handle ASC`,
    )
    .all(...ids);
  const byPerson = new Map<string, PersonIdentityRecord[]>();
  for (const r of identityRows) {
    const list = byPerson.get(r.person_id) ?? [];
    list.push({
      connector: r.connector,
      handle: r.handle,
      displayName: r.display_name,
      observedAt: r.observed_at,
    });
    byPerson.set(r.person_id, list);
  }

  return persons.map((p) => ({
    id: p.id,
    displayName: p.display_name,
    identityCount: p.identity_count,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    identities: byPerson.get(p.id) ?? [],
  }));
}

/**
 * Stable keys for brief completeness signals (Issue #189). Each marks a
 * category that is empty because its source is *not wired up* — not because the
 * window is genuinely quiet — so the host can tell "Slack not connected" from
 * "nothing happened".
 */
export type BriefWarningKey = "slack_not_configured" | "embedding_disabled";

/** A single completeness signal: a stable {@link BriefWarningKey} + a human note. */
export interface BriefWarning {
  /** Stable, machine-matchable key. */
  key: BriefWarningKey;
  /** Human-readable, one-line explanation of the missing category. */
  message: string;
}

const BRIEF_WARNING_MESSAGE: Record<BriefWarningKey, string> = {
  slack_not_configured: "Slack connector not configured — demand (@mention / DM) is always empty",
  embedding_disabled: `embedding backend off — recall-backed material degrades to FTS-only (${docsUrl(
    "guide/embedding.md",
  )})`,
};

/** Inputs for {@link deriveBriefWarnings} — the config facts that gate categories. */
export interface BriefCompleteness {
  /** Whether at least one Slack workspace/operator id is configured. */
  slackConfigured: boolean;
  /** The effective embedding backend (`"disabled"` ⇒ recall degrades to FTS). */
  embeddingBackend: string;
}

/**
 * Derive the brief's completeness {@link BriefWarning}s from config facts
 * (Issue #189). Shared by the CLI and MCP callers so both surface the same
 * stable keys. Pure — no DB / config access; the caller resolves the facts.
 */
export function deriveBriefWarnings(completeness: BriefCompleteness): BriefWarning[] {
  const warnings: BriefWarning[] = [];
  if (!completeness.slackConfigured) {
    warnings.push({
      key: "slack_not_configured",
      message: BRIEF_WARNING_MESSAGE.slack_not_configured,
    });
  }
  if (completeness.embeddingBackend === "disabled") {
    warnings.push({ key: "embedding_disabled", message: BRIEF_WARNING_MESSAGE.embedding_disabled });
  }
  return warnings;
}

/**
 * Per-section truncation flags (ADR-0007 "no silent wrong answer"). Each key is
 * `true` when its section held more rows than the per-section `limit` returned,
 * so the host can tell "a busy day whose bundle was cut" from "genuinely this
 * much happened" and narrow the window / page via the list tools. Mirrors the
 * `truncated` boolean every sibling list tool returns, but per section since the
 * brief bundles several at once.
 */
export interface BriefTruncation {
  sources: boolean;
  tasks: boolean;
  decisions: boolean;
  inbox: boolean;
  demand: boolean;
}

/** A period bundle for host summarization (ADR-0017). */
export interface Brief {
  /** The window the bundle covers (null when unbounded). */
  window: { since: string | null; until: string | null };
  /** Sources observed in the window. */
  sources: SourceRecord[];
  /** Tasks updated in the window. */
  tasks: TaskRecord[];
  /** Decisions recorded in the window. */
  decisions: DecisionRecord[];
  /** Currently-open inbox items (not time-filtered — "what is unprocessed now"). */
  inbox: InboxRecord[];
  /**
   * Outstanding (un-acked) demand observed in the window (ADR-0041): Slack
   * @mentions / DMs + demand-worthy github notifications. Seen (acked / dismissed
   * / github-read) rows are excluded.
   */
  demand: DemandRecord[];
  /**
   * Per-section truncation flags (ADR-0007): `true` where that section was cut
   * off at `limit`. The bundle otherwise looks identical whether a section is
   * complete or silently trimmed on a busy day — this is the signal to page.
   */
  truncated: BriefTruncation;
  /**
   * Completeness signals (Issue #189): categories that are empty because their
   * source is *not configured*, not because the window is quiet. Empty array
   * when every category is wired up.
   */
  warnings: BriefWarning[];
}

export interface BuildBriefOptions {
  /** Window lower bound (inclusive), ISO 8601. */
  since?: string;
  /** Window upper bound (exclusive), ISO 8601. */
  until?: string;
  /** Per-section row cap. */
  limit?: number;
  /** Operator Slack user ids for demand `<@you>` mentions (ADR-0012). */
  selfUserIds?: string[];
  /**
   * Completeness signals (Issue #189). Caller-supplied so `buildBrief` stays
   * pure (no config knowledge); derive via {@link deriveBriefWarnings}.
   */
  warnings?: BriefWarning[];
}

/**
 * Assemble the period's material (ADR-0017) so the host LLM can compose the
 * summary in one round-trip. Pure composition of the existing read queries with
 * each section's natural time column — no in-process LLM (ADR-0006), no persist.
 *
 * Completeness `warnings` (Issue #189) are passed through verbatim from the
 * caller (which knows the config); empty when omitted.
 */
export function buildBrief(sqlite: Database, options: BuildBriefOptions = {}): Brief {
  const { since, until, limit, selfUserIds, warnings } = options;
  const window: TimeRange = { after: since, before: until };
  // Effective per-section cap (each list query defaults to DEFAULT_LIST_LIMIT).
  // Probe every section with limit+1 so a section cut off at the cap is reported
  // via `truncated`, not silently trimmed (ADR-0007 "no silent wrong answer") —
  // the same contract the sibling list tools honour via listWithTruncation.
  const effLimit = limit ?? DEFAULT_LIST_LIMIT;
  const sources = listWithTruncation(effLimit, (probeLimit) =>
    listSources(sqlite, { observed: window, limit: probeLimit }),
  );
  const tasks = listWithTruncation(effLimit, (probeLimit) =>
    listTasks(sqlite, { updated: window, limit: probeLimit }),
  );
  const decisions = listWithTruncation(effLimit, (probeLimit) =>
    listDecisions(sqlite, { recorded: window, limit: probeLimit }),
  );
  // Inbox is "currently open", not period-scoped (what is unprocessed now).
  const inbox = listWithTruncation(effLimit, (probeLimit) =>
    listInbox(sqlite, { state: "open", limit: probeLimit }),
  );
  // Outstanding (un-acked) demand only — a seen mention no longer clutters the
  // brief (ADR-0041). Neutral: Slack @mention/DM + github notifications.
  const demand = listWithTruncation(effLimit, (probeLimit) =>
    listDemand(sqlite, {
      observed: window,
      ...(selfUserIds ? { selfUserIds } : {}),
      limit: probeLimit,
    }),
  );
  return {
    window: { since: since ?? null, until: until ?? null },
    sources: sources.rows,
    tasks: tasks.rows,
    decisions: decisions.rows,
    inbox: inbox.rows,
    demand: demand.rows,
    truncated: {
      sources: sources.truncated,
      tasks: tasks.truncated,
      decisions: decisions.truncated,
      inbox: inbox.truncated,
      demand: demand.truncated,
    },
    warnings: warnings ?? [],
  };
}

// --- Deterministic cross-entity priority scorer (ADR-0041 決定 3) ---------------

/**
 * The rule tier that placed a priority row — its "why it ranked here" (ADR-0041):
 *   - `overdue`        — an overdue task / commitment (the strongest signal, top)
 *   - `unacked_demand` — an outstanding @mention / DM / notification (freshness)
 *   - `due_soon`       — has an upcoming due date (nearest first)
 *   - `priority`       — no due date, but a priority (high > normal > low)
 *   - `recency`        — none of the above; most-recently-updated
 */
export type PriorityReason = "overdue" | "unacked_demand" | "due_soon" | "priority" | "recency";

/** One ranked next-action row (ADR-0041): a task, commitment, or demand signal. */
export interface PriorityItem {
  /** 1-based position in the ranked list (stable for identical input). */
  rank: number;
  /** Which projection the row came from. */
  entity: "task" | "commitment" | "demand";
  /** task id / commitment id / demand `externalId`. */
  id: string;
  /** Short human-readable label (task/commitment title, or demand body summary). */
  title: string;
  /** The rule tier that determined placement (the score rationale). */
  reason: PriorityReason;
  /** One-line human explanation of the rationale. */
  explanation: string;
  /** Whether the row is overdue (task / commitment only). */
  overdue: boolean;
  /** Due date driving `due_soon` / `overdue` (null for demand / undated). */
  dueDate: string | null;
  /** Task priority (low / normal / high); null for commitment / demand. */
  priority: string | null;
  /** The underlying projection record. */
  record: TaskRecord | CommitmentRecord | DemandRecord;
}

export interface BuildPrioritiesOptions {
  /** Operator Slack user ids for demand `<@you>` mentions (ADR-0012). */
  selfUserIds?: string[];
  /**
   * Reference "now" for overdue / freshness (ISO 8601). Injectable so the ranking
   * is deterministic under test (ADR-0028); defaults to the current wall clock.
   */
  now?: string;
  /** Max rows in the ranked list (default {@link DEFAULT_LIST_LIMIT}). */
  limit?: number;
}

/** The ranked cross-entity next-actions list (ADR-0041). */
export interface Priorities {
  /** The `now` the overdue / freshness derivation used. */
  now: string;
  /** Ranked rows, most-important first. */
  items: PriorityItem[];
  /** `true` when more candidates matched than `limit` returned (ADR-0007). */
  truncated: boolean;
}

/** Map a task priority to a sortable rank (higher = more urgent; null = 0). */
const PRIORITY_RANK: Record<string, number> = { high: 3, normal: 2, low: 1 };
function priorityRank(priority: string | null): number {
  return priority !== null ? (PRIORITY_RANK[priority] ?? 0) : 0;
}

/** Per-source-list candidate cap = the `limit` ceiling (docs/design/mcp-surface). */
const PRIORITY_CANDIDATE_CAP = 500;

/** Internal ranked row carrying the computed sort keys (ADR-0041 comparator). */
interface RankedCandidate {
  tier: 0 | 1 | 2;
  entity: "task" | "commitment" | "demand";
  id: string;
  title: string;
  overdue: boolean;
  dueDate: string | null;
  priority: string | null;
  prioRank: number;
  /** Demand freshness key (`observed_at`); null for task / commitment. */
  observedAt: string | null;
  /** Recency key: `updated_at` (task / commitment) or `observed_at` (demand). */
  recencyKey: string;
  record: TaskRecord | CommitmentRecord | DemandRecord;
}

/**
 * Total order over candidates (ADR-0041 決定 3). Lexicographic by tier, then the
 * tier-appropriate sub-keys, with deterministic tie-breaks so identical input
 * always yields identical order (pinned by tests):
 *   overdue (tier 0) > un-acked demand (tier 1) > everything else (tier 2)
 * Within a task/commitment tier: dated-before-undated → nearest due date →
 * higher priority → most-recently-updated. Within demand: freshest first.
 * Final tie-break: entity then id (ascending).
 */
function comparePriority(a: RankedCandidate, b: RankedCandidate): number {
  if (a.tier !== b.tier) return a.tier - b.tier;
  if (a.tier === 1) {
    // Demand: freshness (newest observed_at first), then externalId desc.
    if (a.observedAt !== b.observedAt) return (a.observedAt ?? "") < (b.observedAt ?? "") ? 1 : -1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  }
  // Tasks / commitments (overdue tier 0 or plain tier 2).
  const aDue = a.dueDate;
  const bDue = b.dueDate;
  if ((aDue === null) !== (bDue === null)) return aDue === null ? 1 : -1; // dated rows first
  if (aDue !== null && bDue !== null && aDue !== bDue) return aDue < bDue ? -1 : 1; // sooner first
  if (a.prioRank !== b.prioRank) return b.prioRank - a.prioRank; // higher priority first
  if (a.recencyKey !== b.recencyKey) return a.recencyKey < b.recencyKey ? 1 : -1; // newer first
  if (a.entity !== b.entity) return a.entity < b.entity ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The tier a candidate falls into (ADR-0041). */
function tierOf(overdue: boolean, entity: RankedCandidate["entity"]): 0 | 1 | 2 {
  if (overdue) return 0;
  if (entity === "demand") return 1;
  return 2;
}

/** Score rationale for a candidate (the tier that placed it, ADR-0041). */
function reasonOf(c: RankedCandidate): PriorityReason {
  if (c.tier === 0) return "overdue";
  if (c.tier === 1) return "unacked_demand";
  if (c.dueDate !== null) return "due_soon";
  if (c.prioRank > 0) return "priority";
  return "recency";
}

/** One-line human explanation for a scored candidate. */
function explanationOf(c: RankedCandidate): string {
  switch (reasonOf(c)) {
    case "overdue":
      return `${c.entity} overdue (due ${c.dueDate})`;
    case "unacked_demand":
      return `unprocessed ${(c.record as DemandRecord).kind} demand`;
    case "due_soon":
      return `due ${c.dueDate}`;
    case "priority":
      return `priority ${c.priority}`;
    default:
      return "most recently updated";
  }
}

/** First non-empty line of a demand body, trimmed to a short label. */
function demandTitle(body: string): string {
  const line =
    body
      .split("\n")
      .find((l) => l.trim() !== "")
      ?.trim() ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/**
 * Compose the deterministic cross-entity next-actions ranking (ADR-0041 決定 3):
 * open/in-progress tasks + open commitments + **outstanding (un-acked) demand**,
 * merged into one ranked list by a fixed comparator (see {@link comparePriority}).
 *
 * The order basis lives in code (not skill prose): overdue > un-acked demand
 * (freshness) > due-date proximity > priority > recency. Each row carries a
 * `reason` (the tier that placed it) + `explanation` so the host can show *why*
 * a row is on top. An **acked** mention drops out of the demand tier entirely
 * (it is no longer un-acked), so it can no longer sit permanently above dated
 * work — the bug ADR-0041 fixes. The host may still override with conversational
 * context ("ignore Slack today"); this is the reproducible baseline it starts
 * from. Pure SELECT + in-memory sort — no LLM (ADR-0006), no persist.
 */
export function buildPriorities(
  sqlite: Database,
  options: BuildPrioritiesOptions = {},
): Priorities {
  const now = options.now ?? new Date().toISOString();
  const limit = options.limit ?? DEFAULT_LIST_LIMIT;
  const selfUserIds = options.selfUserIds ?? [];

  const candidates: RankedCandidate[] = [];

  // Active tasks (open + in_progress) — completed / dropped / proposed excluded.
  for (const state of ["open", "in_progress"] as const) {
    for (const task of listTasks(sqlite, { state, now, limit: PRIORITY_CANDIDATE_CAP })) {
      const tier = tierOf(task.overdue, "task");
      candidates.push({
        tier,
        entity: "task",
        id: task.id,
        title: task.title,
        overdue: task.overdue,
        dueDate: task.dueDate,
        priority: task.priority,
        prioRank: priorityRank(task.priority),
        observedAt: null,
        recencyKey: task.updatedAt,
        record: task,
      });
    }
  }

  // Open commitments — overdue derived like a task (past due AND still open).
  for (const c of listCommitments(sqlite, { state: "open", limit: PRIORITY_CANDIDATE_CAP })) {
    const overdue = c.dueDate !== null && c.dueDate < now;
    candidates.push({
      tier: tierOf(overdue, "commitment"),
      entity: "commitment",
      id: c.id,
      title: c.title,
      overdue,
      dueDate: c.dueDate,
      priority: null,
      prioRank: 0,
      observedAt: null,
      recencyKey: c.updatedAt,
      record: c,
    });
  }

  // Outstanding (un-acked) demand — a seen mention is already filtered out.
  for (const d of listDemand(sqlite, {
    ...(selfUserIds.length > 0 ? { selfUserIds } : {}),
    limit: PRIORITY_CANDIDATE_CAP,
  })) {
    candidates.push({
      tier: 1,
      entity: "demand",
      id: d.externalId,
      title: demandTitle(d.body),
      overdue: false,
      dueDate: null,
      priority: null,
      prioRank: 0,
      observedAt: d.observedAt,
      recencyKey: d.observedAt,
      record: d,
    });
  }

  candidates.sort(comparePriority);
  const truncated = candidates.length > limit;
  const items: PriorityItem[] = candidates.slice(0, limit).map((c, i) => ({
    rank: i + 1,
    entity: c.entity,
    id: c.id,
    title: c.title,
    reason: reasonOf(c),
    explanation: explanationOf(c),
    overdue: c.overdue,
    dueDate: c.dueDate,
    priority: c.priority,
    record: c.record,
  }));
  return { now, items, truncated };
}

/** One graph node: a projection entity addressed by kind + id (ADR-0018). */
export interface GraphNode {
  kind: string;
  id: string;
}

/** A neighbour reached from an origin node in one hop, with the edge it crossed. */
export interface GraphNeighbor extends GraphNode {
  /**
   * The link's relation label (`derived_from` / `replies_to` / `references` /
   * `manual_link`).
   */
  relation: string;
  /** `out` = origin is the link's `from`; `in` = origin is the link's `to`. */
  direction: "out" | "in";
  /**
   * Stable id of a manual link (present only for `manual_link` edges, #90), so a
   * caller can target it with `link.remove`. Reducer-derived edges omit it.
   */
  linkId?: string;
}

export interface ListLinksOptions {
  /** Which edge directions to follow (default `both`). */
  direction?: "out" | "in" | "both";
  /** Restrict to a single relation label. */
  relation?: string;
}

interface LinkRow {
  from_kind: string;
  from_id: string;
  to_kind: string;
  to_id: string;
  relation: string;
  link_id: string | null;
}

/**
 * One-hop neighbours of an entity over the `links` provenance projection
 * (ADR-0018). Follows `out` edges (origin is `from`) and/or `in` edges (origin
 * is `to`). Read-only; reducer-derived relations plus manual links (#90, which
 * carry a `linkId` so `link.remove` can target them) are returned uniformly.
 */
export function listLinks(
  sqlite: Database,
  kind: string,
  id: string,
  options: ListLinksOptions = {},
): GraphNeighbor[] {
  const direction = options.direction ?? "both";
  const relClause = options.relation ? " AND relation = ?" : "";
  const relParam = options.relation ? [options.relation] : [];
  const out: GraphNeighbor[] = [];

  if (direction === "out" || direction === "both") {
    const rows = sqlite
      .query<LinkRow, (string | number)[]>(
        `SELECT from_kind, from_id, to_kind, to_id, relation, link_id
           FROM links WHERE from_kind = ? AND from_id = ?${relClause}`,
      )
      .all(kind, id, ...relParam);
    for (const r of rows) {
      out.push({
        kind: r.to_kind,
        id: r.to_id,
        relation: r.relation,
        direction: "out",
        ...(r.link_id !== null ? { linkId: r.link_id } : {}),
      });
    }
  }
  if (direction === "in" || direction === "both") {
    const rows = sqlite
      .query<LinkRow, (string | number)[]>(
        `SELECT from_kind, from_id, to_kind, to_id, relation, link_id
           FROM links WHERE to_kind = ? AND to_id = ?${relClause}`,
      )
      .all(kind, id, ...relParam);
    for (const r of rows) {
      out.push({
        kind: r.from_kind,
        id: r.from_id,
        relation: r.relation,
        direction: "in",
        ...(r.link_id !== null ? { linkId: r.link_id } : {}),
      });
    }
  }
  return out;
}

/** A directed edge in a graph expansion (always `from` → `to`). */
export interface GraphEdge {
  from: GraphNode;
  to: GraphNode;
  relation: string;
}

/** The result of a breadth-first graph expansion (origin is `nodes[0]`). */
export interface GraphExpansion {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface ExpandGraphOptions {
  /** Max hops from the origin (default 2). */
  depth?: number;
  /** Cap on total nodes returned (default {@link DEFAULT_LIST_LIMIT}). */
  limit?: number;
  /**
   * Which edge directions to follow per hop (default `both`, backwards
   * compatible). `in` traces incoming provenance (this entity is derived from /
   * replies to what?) — the backward `graph trace` of ADR-0020; `out` expands
   * downstream consumers.
   */
  direction?: "out" | "in" | "both";
}

const nodeKey = (kind: string, id: string) => `${kind} ${id}`;
const edgeKey = (e: GraphEdge) =>
  `${e.from.kind} ${e.from.id} ${e.to.kind} ${e.to.id} ${e.relation}`;

/**
 * Breadth-first expansion from an origin entity over `links` (ADR-0018), bounded
 * by `depth` and `limit`. A visited-set prevents cycles; edges are de-duplicated
 * (the same edge is reachable from both endpoints in `both`-direction hops).
 *
 * `direction` (ADR-0020) bounds which edges each hop follows: `both` (default,
 * backwards compatible), `in` for a backward provenance trace, or `out` for a
 * downstream expansion. The cycle guard and edge de-dup apply after the
 * direction filter.
 */
export function expandGraph(
  sqlite: Database,
  kind: string,
  id: string,
  options: ExpandGraphOptions = {},
): GraphExpansion {
  const depth = options.depth ?? 2;
  const limit = options.limit ?? DEFAULT_LIST_LIMIT;
  const direction = options.direction ?? "both";
  const visited = new Set<string>([nodeKey(kind, id)]);
  const seenEdges = new Set<string>();
  const nodes: GraphNode[] = [{ kind, id }];
  const edges: GraphEdge[] = [];
  let frontier: GraphNode[] = [{ kind, id }];

  for (let hop = 0; hop < depth && frontier.length > 0; hop += 1) {
    const next: GraphNode[] = [];
    for (const node of frontier) {
      for (const nb of listLinks(sqlite, node.kind, node.id, { direction })) {
        const target: GraphNode = { kind: nb.kind, id: nb.id };
        const edge: GraphEdge =
          nb.direction === "out"
            ? { from: node, to: target, relation: nb.relation }
            : { from: target, to: node, relation: nb.relation };
        const ek = edgeKey(edge);
        if (!seenEdges.has(ek)) {
          seenEdges.add(ek);
          edges.push(edge);
        }
        const nk = nodeKey(nb.kind, nb.id);
        if (!visited.has(nk)) {
          visited.add(nk);
          nodes.push(target);
          next.push(target);
          if (nodes.length >= limit) return { nodes, edges };
        }
      }
    }
    frontier = next;
  }
  return { nodes, edges };
}

/** Fetch a single task by id (read-time overdue derived), or `null` when absent. */
export function getTask(
  sqlite: Database,
  taskId: string,
  options: { now?: string } = {},
): TaskRecord | null {
  const now = options.now ?? new Date().toISOString();
  const row = sqlite
    .query<TaskRow, [string]>(
      `SELECT id, title, state, due_date, priority, created_at, updated_at
         FROM tasks WHERE id = ?`,
    )
    .get(taskId);
  if (row === null) return null;
  return {
    id: row.id,
    title: row.title,
    state: row.state,
    dueDate: row.due_date,
    priority: row.priority,
    overdue: isOverdue(row.due_date, row.state, now),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Fetch a single decision by id, or `null` when absent. */
export function getDecision(sqlite: Database, decisionId: string): DecisionRecord | null {
  const row = sqlite
    .query<DecisionRow, [string]>(
      "SELECT id, title, rationale, recorded_at FROM decisions WHERE id = ?",
    )
    .get(decisionId);
  if (row === null) return null;
  return { id: row.id, title: row.title, rationale: row.rationale, recordedAt: row.recorded_at };
}

/** Entity kinds that {@link buildActivityTimeline} threads onto the timeline. */
export const ACTIVITY_KINDS = ["source", "task", "decision"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** One item on an entity's activity timeline (Issue #279). */
export interface ActivityItem {
  /** Which projection the item came from. */
  kind: ActivityKind;
  /** The entity's id (source externalId / task id / decision id). */
  id: string;
  /**
   * The item's position on the timeline (ISO 8601): each kind's natural moment —
   * source `observed_at`, task `updated_at`, decision `recorded_at`.
   */
  at: string;
  /** The full projection record (SourceRecord / TaskRecord / DecisionRecord). */
  record: SourceRecord | TaskRecord | DecisionRecord;
}

export interface ActivityTimelineOptions {
  /** How far to walk the provenance graph from the origin entity (default 2). */
  depth?: number;
  /** Inclusive lower / exclusive upper bound on each item's `at` timestamp. */
  window?: TimeRange;
  /** Max items returned, newest-first (default {@link DEFAULT_LIST_LIMIT}). */
  limit?: number;
  /** Reference "now" for task overdue derivation (ISO 8601; injectable for tests). */
  now?: string;
  /**
   * Cap on graph nodes explored while discovering related entities (keeps a
   * dense graph bounded). Defaults to a generous multiple of `limit`.
   *
   * NOTE — completeness bound: `expandGraph` truncates in breadth-first (hop-
   * distance) order once this cap is hit, *before* the timeline is sorted
   * newest-first. So on a provenance graph whose reachable node count exceeds
   * `graphLimit`, items that are newer but farther (more hops) from the origin
   * can be dropped — the "newest-first" guarantee holds only within the
   * graph-reachable subset. The default ceiling is deliberately generous (≥ 4×
   * `limit`); raise it (or lower `depth`) for very dense origins where exhaustive
   * recency coverage matters.
   */
  graphLimit?: number;
}

/** An entity's activity timeline: merged source/task/decision items, newest-first. */
export interface ActivityTimeline {
  /** The entity the timeline is centred on. */
  origin: GraphNode;
  /** The covered window (null bound when unbounded). */
  window: { since: string | null; until: string | null };
  /** Items sorted by `at` DESC (newest-first), capped to `limit`. */
  items: ActivityItem[];
}

/** The natural timeline timestamp for each kind's record. */
function activityAt(kind: ActivityKind, record: ActivityItem["record"]): string {
  switch (kind) {
    case "source":
      return (record as SourceRecord).observedAt;
    case "task":
      return (record as TaskRecord).updatedAt;
    case "decision":
      return (record as DecisionRecord).recordedAt;
  }
}

/**
 * Build an entity's activity timeline (`activity.timeline`, Issue #279): the
 * sources / tasks / decisions provenance-connected to an origin entity (kind +
 * id), merged and sorted into one time-ordered view. Where `brief` is period-
 * axis only, this is entity-axis — "everything around this person/project/source".
 *
 * Implementation: walk the `links` provenance graph from the origin
 * (`expandGraph`, both directions) to discover related entities, fetch each
 * reached source/task/decision via the existing query layer, stamp each with its
 * natural timestamp (source observed / task updated / decision recorded), apply
 * the optional time window, then sort newest-first and cap to `limit`. The origin
 * entity itself is included when it is one of the timeline kinds. Pure SELECTs.
 *
 * Completeness is bounded by `depth` and `graphLimit`: the graph walk truncates
 * in breadth-first order before the newest-first sort, so a very dense origin can
 * drop newer-but-farther items (see {@link ActivityTimelineOptions.graphLimit}).
 */
export function buildActivityTimeline(
  sqlite: Database,
  kind: string,
  id: string,
  options: ActivityTimelineOptions = {},
): ActivityTimeline {
  const limit = options.limit ?? DEFAULT_LIST_LIMIT;
  const now = options.now ?? new Date().toISOString();
  const depth = options.depth ?? 2;
  // Explore enough of the graph to fill the timeline without unbounded growth.
  const graphLimit = options.graphLimit ?? Math.max(limit * 4, DEFAULT_LIST_LIMIT);

  // Discover related entities (and the origin itself) over the provenance graph.
  const { nodes } = expandGraph(sqlite, kind, id, {
    depth,
    direction: "both",
    limit: graphLimit,
  });

  const isActivityKind = (k: string): k is ActivityKind =>
    (ACTIVITY_KINDS as readonly string[]).includes(k);

  const items: ActivityItem[] = [];
  for (const node of nodes) {
    if (!isActivityKind(node.kind)) continue;
    const record: ActivityItem["record"] | null =
      node.kind === "source"
        ? getSource(sqlite, node.id)
        : node.kind === "task"
          ? getTask(sqlite, node.id, { now })
          : getDecision(sqlite, node.id);
    if (record === null) continue;
    const at = activityAt(node.kind, record);
    if (options.window?.after !== undefined && at < options.window.after) continue;
    if (options.window?.before !== undefined && at >= options.window.before) continue;
    items.push({ kind: node.kind, id: node.id, at, record });
  }

  // Newest-first; ties broken by (kind, id) for a deterministic order.
  items.sort((a, b) =>
    a.at === b.at ? `${a.kind} ${a.id}`.localeCompare(`${b.kind} ${b.id}`) : a.at < b.at ? 1 : -1,
  );

  return {
    origin: { kind, id },
    window: { since: options.window?.after ?? null, until: options.window?.before ?? null },
    items: items.slice(0, limit),
  };
}

/**
 * The set of external item ids that are already a published task's home item
 * (ADR-0036 §8 loop avoidance). Drawn from both `tasks.published_external_id`
 * and the `published_to` links (the reducer records both with the same id; the
 * OR makes the lookup robust across a `projections rebuild`). Used by
 * `persistProposals` to skip re-proposing a task suasor itself published.
 */
export function publishedTaskExternalIds(sqlite: Database): Set<string> {
  const rows = sqlite
    .query(
      `SELECT published_external_id AS id FROM tasks WHERE published_external_id IS NOT NULL
       UNION
       SELECT to_id AS id FROM links WHERE relation = 'published_to'`,
    )
    .all() as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}
