/**
 * `propose.apply` — persist approved candidates as domain events (ADR-0004 /
 * FR-PRO-2 / docs/design/mcp-surface.md).
 *
 * This is the only path that turns a proposal into stored state, and it runs
 * only after a human has approved the specific candidates (the host gates it via
 * `readOnlyHint: false`; there is no auto-apply path, ADR-0004). Each candidate
 * kind maps 1:1 to a domain event appended through `Store.record` (append + fold
 * in one transaction, ADR-0002):
 *   - `task`        → `TaskProposed`
 *   - `decision`    → `DecisionRecorded`
 *   - `reply_draft` → `ReplyDraftProposed`
 *   - `triage`      → `InboxItemTriaged`
 *   - `commitment`  → `CommitmentOpened` (ADR-0021)
 *
 * Idempotence (the issue's acceptance criterion): each candidate's target entity
 * id is content-derived (id.ts), and apply first checks the projection for that
 * id — if it already exists, the candidate is reported `skipped` and NO event is
 * appended, so re-applying the same approved set is a no-op (no duplicate events,
 * no projection drift). This keeps the append-only log free of redundant entries
 * while staying replay-deterministic.
 */
import { z } from "zod";
import type { loadActuator } from "../connectors/actuator-registry.ts";
import type { Store } from "../db/index.ts";
import { appendEvent } from "../events/store.ts";
import type { NewEvent } from "../events/types.ts";
import { applyEvent } from "../projections/reducer.ts";
import { type Candidate, Candidate as CandidateSchema } from "./candidates.ts";
import { entityId } from "./id.ts";
import { type TaskHomeConfig, taskPublish } from "./task-publish.ts";

/** Input to `propose.apply`: the approved, id-stamped candidates to persist. */
export const ProposeApplyInput = z.object({
  candidates: z.array(CandidateSchema).min(1),
  /**
   * When true, each applied/skipped **task** candidate is also published to the
   * single external home (`[tasks.home]`) in one motion (ADR-0036). Default false
   * (apply only). Non-task candidates ignore it; HITL is unchanged (the apply
   * approval gates the egress too). Publish is best-effort per task — a failure
   * is reported in `published[]`, never thrown (apply results are preserved).
   */
  publish: z.boolean().default(false),
});
/** Accepted at the call site (candidate defaults applied by `parse`). */
export type ProposeApplyInput = z.input<typeof ProposeApplyInput>;

/** Per-candidate apply result: `applied` (event appended) or `skipped` (existing). */
export interface AppliedCandidate {
  candidateId: string;
  kind: Candidate["kind"];
  /** Target entity id the event carries / upserted. */
  entityId: string;
  status: "applied" | "skipped";
}

/** Per-task publish result when `publish: true` (best-effort; never throws). */
export interface PublishedTask {
  taskId: string;
  externalId?: string;
  status: "published" | "existing" | "failed";
  error?: string;
}

export interface ProposeApplyOutput {
  results: AppliedCandidate[];
  applied: number;
  skipped: number;
  /** Present when `publish: true`: one entry per task candidate that was published. */
  published?: PublishedTask[];
}

/** Optional deps for the publish phase (config + injectable actuator loader for tests). */
export interface ProposeApplyDeps {
  config?: TaskHomeConfig;
  loadActuatorImpl?: typeof loadActuator;
}

/** True when an entity with this id already exists in the relevant projection. */
export function entityExists(store: Store, candidate: Candidate, id: string): boolean {
  const sqlite = store.connection.sqlite;
  switch (candidate.kind) {
    case "task":
      return sqlite.query("SELECT 1 FROM tasks WHERE id = ?").get(id) !== null;
    case "decision":
      return sqlite.query("SELECT 1 FROM decisions WHERE id = ?").get(id) !== null;
    case "reply_draft":
      // Reply drafts have no projection row of their own; their identity lives in
      // the `links` provenance graph (reply_draft → source, relation replies_to).
      return (
        sqlite
          .query("SELECT 1 FROM links WHERE from_kind = 'reply_draft' AND from_id = ?")
          .get(id) !== null
      );
    case "triage":
      // Triage is idempotent on (inboxId, state): re-applying the same target
      // state is a no-op, but moving to a different state must still apply.
      return (
        sqlite.query("SELECT 1 FROM inbox WHERE id = ? AND state = ?").get(id, candidate.state) !==
        null
      );
    case "commitment":
      // A commitment already in the ledger (any state) is a no-op: re-extracting
      // it must not resurrect a resolved/dismissed one nor duplicate an open one.
      return sqlite.query("SELECT 1 FROM commitments WHERE id = ?").get(id) !== null;
  }
}

/** Build the domain event a candidate maps to, targeting the given entity id. */
export function candidateToEvent(candidate: Candidate, id: string): NewEvent {
  switch (candidate.kind) {
    case "task":
      return {
        type: "TaskProposed",
        taskId: id,
        title: candidate.title,
        sourceExternalIds: candidate.sourceExternalIds,
      };
    case "decision":
      return {
        type: "DecisionRecorded",
        decisionId: id,
        title: candidate.title,
        rationale: candidate.rationale,
        sourceExternalIds: candidate.sourceExternalIds,
      };
    case "reply_draft":
      return {
        type: "ReplyDraftProposed",
        draftId: id,
        replyToExternalId: candidate.replyToExternalId,
        body: candidate.body,
      };
    case "triage":
      return {
        type: "InboxItemTriaged",
        inboxId: id,
        sourceExternalId: candidate.sourceExternalId,
        state: candidate.state,
      };
    case "commitment":
      return {
        type: "CommitmentOpened",
        commitmentId: id,
        title: candidate.title,
        direction: candidate.direction,
        dueDate: candidate.dueDate,
        person: candidate.person,
        sourceExternalIds: candidate.sourceExternalIds,
      };
  }
}

/**
 * Apply one approved candidate WITHOUT opening its own transaction (cf.
 * `proposeApply`, which records each candidate in a per-candidate transaction).
 * The caller is responsible for the transaction boundary — `propose.batch`
 * (src/propose/batch.ts) wraps a whole mixed apply/reject set in a single
 * transaction and calls this per apply op so the batch is atomic (Issue #197).
 *
 * Same idempotence contract as `proposeApply`: an existing entity (matched by
 * content-derived id) is `skipped` and NO event is appended.
 */
export function applyCandidateStep(
  store: Store,
  candidate: Candidate,
  now: Date,
): AppliedCandidate {
  const id = entityId(candidate);
  if (entityExists(store, candidate, id)) {
    return {
      candidateId: candidate.candidateId,
      kind: candidate.kind,
      entityId: id,
      status: "skipped",
    };
  }
  const persisted = appendEvent(store.connection.sqlite, candidateToEvent(candidate, id), now);
  applyEvent(store.connection.sqlite, persisted);
  return {
    candidateId: candidate.candidateId,
    kind: candidate.kind,
    entityId: id,
    status: "applied",
  };
}

/**
 * Apply approved candidates, appending one event per *new* candidate. Existing
 * entities (matched by content-derived id) are skipped, making re-application a
 * no-op (idempotent). The host must have obtained human approval before calling.
 */
export function proposeApply(
  store: Store,
  input: ProposeApplyInput,
  now: Date = new Date(),
): ProposeApplyOutput {
  const { candidates } = ProposeApplyInput.parse(input);
  const results: AppliedCandidate[] = [];

  for (const candidate of candidates) {
    const id = entityId(candidate);
    if (entityExists(store, candidate, id)) {
      results.push({
        candidateId: candidate.candidateId,
        kind: candidate.kind,
        entityId: id,
        status: "skipped",
      });
      continue;
    }
    store.record(candidateToEvent(candidate, id), now);
    results.push({
      candidateId: candidate.candidateId,
      kind: candidate.kind,
      entityId: id,
      status: "applied",
    });
  }

  const applied = results.filter((r) => r.status === "applied").length;
  return { results, applied, skipped: results.length - applied };
}

/**
 * Apply, then (when `input.publish`) publish the applied/skipped task candidates
 * to the single external home in one motion (ADR-0036, "approve & publish"). A
 * thin async wrapper over the sync {@link proposeApply}: apply is persisted first,
 * then publish runs best-effort per task — failures are reported in `published[]`,
 * never thrown, so a partial publish failure can't lose the apply results.
 */
export async function applyAndPublish(
  store: Store,
  input: ProposeApplyInput,
  now: Date = new Date(),
  deps: ProposeApplyDeps = {},
): Promise<ProposeApplyOutput> {
  const out = proposeApply(store, input, now);
  if (!ProposeApplyInput.parse(input).publish) return out;
  const taskIds = out.results.filter((r) => r.kind === "task").map((r) => r.entityId);
  return { ...out, published: await publishTasks(store, taskIds, now, deps) };
}

/** Publish each task to the home, aggregating per-task results (never throws). */
async function publishTasks(
  store: Store,
  taskIds: string[],
  now: Date,
  deps: ProposeApplyDeps,
): Promise<PublishedTask[]> {
  if (taskIds.length === 0) return [];
  // A single home check up-front: if unset, report each task as failed rather
  // than throwing ACTUATOR_NOT_CONFIGURED per task (apply still succeeded).
  if (!deps.config?.tasks?.home) {
    return taskIds.map((taskId) => ({
      taskId,
      status: "failed" as const,
      error: "no task home configured ([tasks].home)",
    }));
  }
  const published: PublishedTask[] = [];
  for (const taskId of taskIds) {
    try {
      const r = await taskPublish(store, deps.config, { taskId }, now, deps.loadActuatorImpl);
      published.push({ taskId, externalId: r.externalId, status: r.status });
    } catch (err) {
      published.push({ taskId, status: "failed", error: (err as Error).message });
    }
  }
  return published;
}
