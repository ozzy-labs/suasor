/**
 * Projection read queries backing the MCP read tools (ADR-0004, #8).
 *
 * Pure, side-effect-free SELECTs over the projection tables (`sources` /
 * `tasks` / `decisions` / `inbox` / `proposals`) that the MCP `source.list` /
 * `source.get` / `task.list` / `decision.list` / `inbox.list` / `propose.list`
 * read tools wrap. Read tools must have no side effects (ADR-0004
 * `read = destructive:false`), so every function here only reads.
 *
 * Time filters target each projection's natural timestamp column (the same
 * physical column the assistant skills filter on, docs/skills/README.md):
 *   - sources    → `observed_at`   (observed_after / observed_before)
 *   - tasks      → `updated_at`     (updated_after / updated_before)
 *   - decisions  → `recorded_at`    (recorded_after / recorded_before)
 *   - inbox      → `updated_at`     (updated_after / updated_before)
 *   - proposals  → `updated_at`     (updated_after / updated_before)
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

/** A proposal lifecycle ledger row (Issue #89). */
export interface ProposalRecord {
  candidateId: string;
  mode: string;
  kind: string;
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

/** A Slack demand signal: an `@you` mention or a DM, classified by `kind`. */
export interface SlackDemandRecord extends SourceRecord {
  /** `dm` when the source is a direct message; otherwise `mention`. */
  kind: "mention" | "dm";
}

export interface ListSlackDemandOptions {
  /** Operator user ids (`Uxxxx`) for `<@you>` mention detection (ADR-0012). */
  selfUserIds?: string[];
  /** Restrict to these kinds (default: both `mention` and `dm`). */
  kinds?: ("mention" | "dm")[];
  /** Window over `observed_at`. */
  observed?: TimeRange;
  /** Max rows (default {@link DEFAULT_LIST_LIMIT}). */
  limit?: number;
}

/** A `slack_message` source id is a DM when its channel id starts with `D`. */
const DM_CHANNEL_CLAUSE = "json_extract(meta, '$.channel') LIKE 'D%'";

/**
 * List Slack demand — unread-worthy signals derived (FTS-first, no extra fetch)
 * from ingested `slack_message` sources: `@you` mentions and DMs (ADR-0012).
 * Newest-first. A row is `dm` when its channel id starts with `D`, else
 * `mention`. Mentions need `selfUserIds`; without any, only DMs are returned
 * (and a `kinds: ["mention"]` filter then yields nothing).
 */
export function listSlackDemand(
  sqlite: Database,
  options: ListSlackDemandOptions = {},
): SlackDemandRecord[] {
  const kinds = options.kinds ?? ["mention", "dm"];
  const selfUserIds = options.selfUserIds ?? [];

  const orClauses: string[] = [];
  const params: (string | number)[] = [];
  if (kinds.includes("dm")) orClauses.push(DM_CHANNEL_CLAUSE);
  if (kinds.includes("mention")) {
    for (const uid of selfUserIds) {
      orClauses.push("body LIKE ?");
      params.push(`%<@${uid}>%`);
    }
  }
  // No applicable predicate (e.g. mention-only with no self ids) → no demand.
  if (orClauses.length === 0) return [];

  const clauses = ["source_type = 'slack_message'", `(${orClauses.join(" OR ")})`];
  pushTimeRange(clauses, params, "observed_at", options.observed);
  params.push(options.limit ?? DEFAULT_LIST_LIMIT);

  const rows = sqlite
    .query<SourceRow, (string | number)[]>(
      `SELECT external_id, source_type, body, fingerprint, observed_at, meta
         FROM sources
        WHERE ${clauses.join(" AND ")}
        ORDER BY observed_at DESC
        LIMIT ?`,
    )
    .all(...params);

  return rows.map((row) => {
    const record = toSourceRecord(row);
    const channel = typeof record.meta.channel === "string" ? record.meta.channel : "";
    return { ...record, kind: channel.startsWith("D") ? "dm" : "mention" };
  });
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
  /** Slack demand (@mention / DM) observed in the window. */
  demand: SlackDemandRecord[];
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
}

/**
 * Assemble the period's material (ADR-0017) so the host LLM can compose the
 * summary in one round-trip. Pure composition of the existing read queries with
 * each section's natural time column — no in-process LLM (ADR-0006), no persist.
 */
export function buildBrief(sqlite: Database, options: BuildBriefOptions = {}): Brief {
  const { since, until, limit, selfUserIds } = options;
  const window: TimeRange = { after: since, before: until };
  const cap = limit !== undefined ? { limit } : {};
  return {
    window: { since: since ?? null, until: until ?? null },
    sources: listSources(sqlite, { observed: window, ...cap }),
    tasks: listTasks(sqlite, { updated: window, ...cap }),
    decisions: listDecisions(sqlite, { recorded: window, ...cap }),
    // Inbox is "currently open", not period-scoped (what is unprocessed now).
    inbox: listInbox(sqlite, { state: "open", ...cap }),
    demand: listSlackDemand(sqlite, {
      observed: window,
      ...(selfUserIds ? { selfUserIds } : {}),
      ...cap,
    }),
  };
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
}

const nodeKey = (kind: string, id: string) => `${kind} ${id}`;
const edgeKey = (e: GraphEdge) =>
  `${e.from.kind} ${e.from.id} ${e.to.kind} ${e.to.id} ${e.relation}`;

/**
 * Breadth-first expansion from an origin entity over `links` (ADR-0018), bounded
 * by `depth` and `limit`. A visited-set prevents cycles; edges are de-duplicated
 * (the same edge is reachable from both endpoints in `both`-direction hops).
 */
export function expandGraph(
  sqlite: Database,
  kind: string,
  id: string,
  options: ExpandGraphOptions = {},
): GraphExpansion {
  const depth = options.depth ?? 2;
  const limit = options.limit ?? DEFAULT_LIST_LIMIT;
  const visited = new Set<string>([nodeKey(kind, id)]);
  const seenEdges = new Set<string>();
  const nodes: GraphNode[] = [{ kind, id }];
  const edges: GraphEdge[] = [];
  let frontier: GraphNode[] = [{ kind, id }];

  for (let hop = 0; hop < depth && frontier.length > 0; hop += 1) {
    const next: GraphNode[] = [];
    for (const node of frontier) {
      for (const nb of listLinks(sqlite, node.kind, node.id, { direction: "both" })) {
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
