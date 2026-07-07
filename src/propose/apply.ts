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
 * Idempotence is scoped to the proposal round-trip ([boundary/propose-1], Issue
 * #435), not the domain entity's lifetime:
 *   - a persisted candidate whose proposals-ledger round-trip is already `applied`
 *     is a no-op (`skipped`, reason `already_applied`) — re-applying the same
 *     approved set appends nothing;
 *   - otherwise the target id is content-derived (id.ts). For a *task* applied
 *     outside the ledger (a pure generate→apply / direct call), the id is resolved
 *     terminal-aware (`resolveTaskId`): an open instance no-ops (`skipped`, reason
 *     `exists`) but a purely-terminal history mints a fresh recurrence id so an
 *     identically-titled task can coexist rather than being blocked forever.
 * Either way NO event is appended on a skip, so replay stays deterministic (the
 * appended event carries the resolved id).
 */
import { z } from "zod";
import type { loadActuator } from "../connectors/actuator-registry.ts";
import type { Store } from "../db/index.ts";
import { appendEvent } from "../events/store.ts";
import type { NewEvent } from "../events/types.ts";
import { McpToolError } from "../mcp/errors.ts";
import { applyEvent } from "../projections/reducer.ts";
import { type Candidate, Candidate as CandidateSchema } from "./candidates.ts";
import { entityId } from "./id.ts";
import { resolveTaskId } from "./recurrence.ts";
import { hasDefaultHome, type TaskHomeConfig, taskPublish } from "./task-publish.ts";

/** Input to `propose.apply`: the approved, id-stamped candidates to persist. */
export const ProposeApplyInput = z.object({
  candidates: z.array(CandidateSchema).min(1),
  /**
   * When true, each applied/skipped **task** candidate is also published to the
   * default external home (`[tasks].default` → `[tasks.homes.<dest>]`) in one
   * motion (ADR-0036). Default false
   * (apply only). Non-task candidates ignore it; HITL is unchanged (the apply
   * approval gates the egress too). Publish is best-effort per task — a failure
   * is reported in `published[]`, never thrown (apply results are preserved).
   */
  publish: z.boolean().default(false),
});
/** Accepted at the call site (candidate defaults applied by `parse`). */
export type ProposeApplyInput = z.input<typeof ProposeApplyInput>;

/** Per-candidate apply result: `applied` (event appended) or `skipped` (no-op). */
export interface AppliedCandidate {
  candidateId: string;
  kind: Candidate["kind"];
  /** Target entity id the event carries / upserted (the existing one on a skip). */
  entityId: string;
  status: "applied" | "skipped";
  /**
   * Why a candidate was skipped (absent when `applied`):
   *   - `already_applied` — this candidate's proposal round-trip was already
   *     applied (the proposals-ledger dedupe — re-applying an approved set);
   *   - `exists`          — a domain entity / open task instance already exists.
   */
  skipReason?: "already_applied" | "exists";
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

/** A proposals-ledger row's state + target entity id (id generate stored). */
export interface ProposalLedgerRow {
  state: string;
  entityId: string;
}

/**
 * Current proposals-ledger row for a candidateId, or `null` when no ledger row
 * exists (e.g. a pure `proposeGenerate` candidate never persisted, or a direct
 * `task.create` entity that skips the proposal ledger entirely).
 */
export function proposalLedgerRow(store: Store, candidateId: string): ProposalLedgerRow | null {
  const row = store.connection.sqlite
    .query<{ state: string; entity_id: string }, [string]>(
      "SELECT state, entity_id FROM proposals WHERE candidate_id = ?",
    )
    .get(candidateId);
  return row ? { state: row.state, entityId: row.entity_id } : null;
}

/** Current proposals-ledger state for a candidateId (`null` when no ledger row). */
export function proposalLedgerState(store: Store, candidateId: string): string | null {
  return proposalLedgerRow(store, candidateId)?.state ?? null;
}

/**
 * Enforce a human's recorded rejection (ADR-0004, [boundary/missed-reject]).
 * apply/batch used to persist a candidate without ever consulting the proposals
 * ledger, so a `rejected` candidate applied cleanly — minting the domain entity
 * while the ledger row still read `rejected` (a self-contradicting audit trail)
 * and silently overriding the human's "no". A rejected candidateId is now a
 * structured `REJECTED_CANDIDATE` tool error; a candidate with no ledger row is
 * unaffected (idempotence + direct-create paths are unchanged).
 */
export function assertNotRejected(store: Store, candidate: Candidate): void {
  if (proposalLedgerState(store, candidate.candidateId) === "rejected") {
    throw new McpToolError(
      "REJECTED_CANDIDATE",
      `candidate ${candidate.candidateId} was rejected and cannot be applied`,
      "A human rejected this candidate (propose.reject); applying it would contradict that recorded decision.",
    );
  }
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

/** The id to append at, plus (when a no-op) why the candidate is skipped. */
interface ApplyTarget {
  id: string;
  skipReason?: "already_applied" | "exists";
}

/**
 * Decide the target entity id for a candidate and whether it is a no-op, scoping
 * idempotency to the proposal round-trip ([boundary/propose-1]):
 *
 *  1. Ledger round-trip already `applied` → skip (`already_applied`). This is the
 *     primary dedupe for the persisted flow: re-applying an approved set appends
 *     nothing, keyed on the candidateId rather than the entity's lifetime.
 *  2. Ledger-less **task** (pure generate→apply / direct) → resolve terminal-aware
 *     (`resolveTaskId`): an open instance no-ops (`exists`); a purely-terminal
 *     history mints a fresh recurrence id so an identically-titled task coexists.
 *  3. Otherwise (a persisted-pending candidate, or a non-task) → the base content
 *     id. Reusing generate's stored id keeps the reducer's ledger-marking (by
 *     `entity_id`) matching; an already-present entity no-ops (`exists`).
 *
 * The caller must have run `assertNotRejected` first (a `rejected` round-trip
 * throws rather than skipping).
 */
function decideApplyTarget(store: Store, candidate: Candidate): ApplyTarget {
  const ledger = proposalLedgerRow(store, candidate.candidateId);
  if (ledger?.state === "applied") {
    return { id: ledger.entityId, skipReason: "already_applied" };
  }
  if (candidate.kind === "task" && ledger === null) {
    const resolved = resolveTaskId(store, entityId(candidate));
    if (resolved.openDuplicate !== null) {
      return { id: resolved.openDuplicate.taskId, skipReason: "exists" };
    }
    return { id: resolved.id };
  }
  const id = entityId(candidate);
  if (entityExists(store, candidate, id)) return { id, skipReason: "exists" };
  return { id };
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
 * Same idempotence contract as `proposeApply`: an already-applied round-trip or an
 * existing entity/open instance is `skipped` (with its reason) and NO event is
 * appended.
 */
export function applyCandidateStep(
  store: Store,
  candidate: Candidate,
  now: Date,
): AppliedCandidate {
  // Consult the ledger before touching the domain: a rejected candidate must not
  // apply (ADR-0004). Throwing here rolls the whole propose.batch transaction
  // back (all-or-nothing), so a rejected member can't half-commit the batch.
  assertNotRejected(store, candidate);
  const target = decideApplyTarget(store, candidate);
  if (target.skipReason !== undefined) {
    return {
      candidateId: candidate.candidateId,
      kind: candidate.kind,
      entityId: target.id,
      status: "skipped",
      skipReason: target.skipReason,
    };
  }
  const persisted = appendEvent(
    store.connection.sqlite,
    candidateToEvent(candidate, target.id),
    now,
  );
  applyEvent(store.connection.sqlite, persisted);
  return {
    candidateId: candidate.candidateId,
    kind: candidate.kind,
    entityId: target.id,
    status: "applied",
  };
}

/**
 * Apply approved candidates, appending one event per *new* candidate. An
 * already-applied round-trip or an existing entity / open task instance is
 * skipped (with its reason), making re-application a no-op (idempotent, scoped to
 * the proposal round-trip). The host must have obtained human approval first.
 */
export function proposeApply(
  store: Store,
  input: ProposeApplyInput,
  now: Date = new Date(),
): ProposeApplyOutput {
  const { candidates } = ProposeApplyInput.parse(input);

  // Pre-flight the whole set against the ledger BEFORE appending anything: apply
  // is per-candidate (not one transaction), so refusing a rejected candidate
  // up-front keeps a rejected member from partially applying the batch and
  // enforces the recorded "no" (ADR-0004) rather than silently overriding it.
  for (const candidate of candidates) {
    assertNotRejected(store, candidate);
  }

  const results: AppliedCandidate[] = [];

  for (const candidate of candidates) {
    const target = decideApplyTarget(store, candidate);
    if (target.skipReason !== undefined) {
      results.push({
        candidateId: candidate.candidateId,
        kind: candidate.kind,
        entityId: target.id,
        status: "skipped",
        skipReason: target.skipReason,
      });
      continue;
    }
    store.record(candidateToEvent(candidate, target.id), now);
    results.push({
      candidateId: candidate.candidateId,
      kind: candidate.kind,
      entityId: target.id,
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
  // A single home check up-front: if the default destination + its home slice are
  // not configured, report each task as failed rather than throwing
  // ACTUATOR_NOT_CONFIGURED per task (apply still succeeded). Batch publish always
  // targets the default; per-task destinations are a task.publish-only affordance.
  if (!deps.config || !hasDefaultHome(deps.config)) {
    return taskIds.map((taskId) => ({
      taskId,
      status: "failed" as const,
      error: "no task home configured ([tasks].default + [tasks.homes.<default>])",
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
