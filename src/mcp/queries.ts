/**
 * Projection read queries backing the MCP read tools (ADR-0004, #8).
 *
 * Pure, side-effect-free SELECTs over the projection tables (`sources` /
 * `tasks` / `decisions` / `inbox`) that the MCP `source.list` / `source.get` /
 * `task.list` / `decision.list` / `inbox.list` read tools wrap. Read tools must
 * have no side effects (ADR-0004 `read = destructive:false`), so every function
 * here only reads.
 *
 * Time filters target each projection's natural timestamp column (the same
 * physical column the assistant skills filter on, docs/skills/README.md):
 *   - sources    → `observed_at`   (observed_after / observed_before)
 *   - tasks      → `updated_at`     (updated_after / updated_before)
 *   - decisions  → `recorded_at`    (recorded_after / recorded_before)
 *   - inbox      → `updated_at`     (updated_after / updated_before)
 * Bounds are inclusive on the lower end and exclusive on the upper end so
 * adjacent ranges don't double-count, and compare ISO 8601 strings
 * lexicographically (valid because the stored timestamps are zero-padded UTC).
 */
import type { Database } from "bun:sqlite";

/** Default page size for the list queries (matches retrieval's default). */
export const DEFAULT_LIST_LIMIT = 50;

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

/** A task projection row. */
export interface TaskRecord {
  id: string;
  title: string;
  state: string;
  createdAt: string;
  updatedAt: string;
}

interface TaskRow {
  id: string;
  title: string;
  state: string;
  created_at: string;
  updated_at: string;
}

export interface ListTasksOptions {
  /** Restrict to a lifecycle state (proposed/open/in_progress/completed/dropped). */
  state?: string;
  /** Window over `updated_at`. */
  updated?: TimeRange;
  limit?: number;
}

/** List tasks most-recently-updated first. */
export function listTasks(sqlite: Database, options: ListTasksOptions = {}): TaskRecord[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (options.state !== undefined) {
    clauses.push("state = ?");
    params.push(options.state);
  }
  pushTimeRange(clauses, params, "updated_at", options.updated);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(options.limit ?? DEFAULT_LIST_LIMIT);
  const rows = sqlite
    .query<TaskRow, (string | number)[]>(
      `SELECT id, title, state, created_at, updated_at
         FROM tasks
         ${where}
        ORDER BY updated_at DESC
        LIMIT ?`,
    )
    .all(...params);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    state: r.state,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
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
  /** Window over `updated_at`. */
  updated?: TimeRange;
  limit?: number;
}

/** List inbox items most-recently-updated first. */
export function listInbox(sqlite: Database, options: ListInboxOptions = {}): InboxRecord[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (options.state !== undefined) {
    clauses.push("state = ?");
    params.push(options.state);
  }
  pushTimeRange(clauses, params, "updated_at", options.updated);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(options.limit ?? DEFAULT_LIST_LIMIT);
  const rows = sqlite
    .query<InboxRow, (string | number)[]>(
      `SELECT id, source_external_id, state, updated_at
         FROM inbox
         ${where}
        ORDER BY updated_at DESC
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
