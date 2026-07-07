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
 * Idempotence is scoped to the *proposal round-trip*, not the domain entity
 * (#435, [boundary/propose-1]): a candidate whose proposals-ledger row is
 * already `applied` (matched by `candidateId`) is reported `skipped` and NO
 * event is appended, so re-applying the same approved set is a no-op (no
 * duplicate events, no projection drift). For `task` / `decision` the target
 * entity id is minted at apply time (identity.ts): the content-derived base id
 * gets a `-N` suffix when occupied, so identically-titled entities can recur
 * over time instead of colliding with a long-completed row forever.
 * `reply_draft` / `triage` / `commitment` keep their entity-level idempotence
 * (content equality IS semantic equality for those kinds — see entityExists).
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
import { mintEntityId } from "./identity.ts";
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

/** A proposals-ledger row's decision-relevant slice (state + target entity). */
export interface ProposalLedgerRow {
  state: string;
  /** Target entity id — updated to the actually minted id once applied (#435). */
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
  return row === null ? null : { state: row.state, entityId: row.entity_id };
}

/** Current proposals-ledger state for a candidateId (`null` = no ledger row). */
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

/**
 * True when an entity with this id already exists in the relevant projection.
 * Since #435 the apply path consults this only for `reply_draft` / `triage` /
 * `commitment` (whose content equality is semantic equality); `task` /
 * `decision` dedupe on the proposals ledger instead and mint a fresh id when
 * they apply (identity.ts). The task/decision branches remain for direct
 * existence checks (task.create / decision.record and tests).
 */
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

/**
 * Build the domain event a candidate maps to, targeting the given entity id.
 * Task/decision events carry the `candidateId` (#435) so the reducer can flip
 * exactly that proposals-ledger row to `applied` and record the minted id.
 */
export function candidateToEvent(candidate: Candidate, id: string): NewEvent {
  switch (candidate.kind) {
    case "task":
      return {
        type: "TaskProposed",
        taskId: id,
        candidateId: candidate.candidateId,
        title: candidate.title,
        sourceExternalIds: candidate.sourceExternalIds,
      };
    case "decision":
      return {
        type: "DecisionRecorded",
        decisionId: id,
        candidateId: candidate.candidateId,
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
 * Resolve a candidate's target entity id + whether the apply is a no-op.
 * Dedupe order (#435):
 *   1. Same candidateId already applied earlier in THIS call/batch (`seen`) —
 *      skipped, echoing the id minted then (covers ledger-less duplicates).
 *   2. Proposals-ledger row already `applied` — skipped, echoing the entity id
 *      the ledger recorded (the round-trip idempotence contract).
 *   3. `task` / `decision` — mint a fresh id (base or `-N`-suffixed) and apply;
 *      an occupied base id no longer blocks a recurring title.
 *   4. Other kinds — entity-level idempotence unchanged (existing → skipped).
 */
function resolveCandidateTarget(
  store: Store,
  candidate: Candidate,
  seen: Map<string, string> | undefined,
): { id: string; status: AppliedCandidate["status"] } {
  const seenId = seen?.get(candidate.candidateId);
  if (seenId !== undefined) return { id: seenId, status: "skipped" };
  const ledger = proposalLedgerRow(store, candidate.candidateId);
  if (ledger !== null && ledger.state === "applied") {
    return { id: ledger.entityId, status: "skipped" };
  }
  if (candidate.kind === "task" || candidate.kind === "decision") {
    return { id: mintEntityId(store.connection.sqlite, candidate), status: "applied" };
  }
  const id = entityId(candidate);
  return { id, status: entityExists(store, candidate, id) ? "skipped" : "applied" };
}

/**
 * Apply one approved candidate WITHOUT opening its own transaction (cf.
 * `proposeApply`, which records each candidate in a per-candidate transaction).
 * The caller is responsible for the transaction boundary — `propose.batch`
 * (src/propose/batch.ts) wraps a whole mixed apply/reject set in a single
 * transaction and calls this per apply op so the batch is atomic (Issue #197).
 *
 * Same idempotence contract as `proposeApply` (round-trip scoped, #435). The
 * optional `seen` map (candidateId → minted entity id) carries in-call dedupe
 * state across the ops of one batch; pass the same map for every op.
 */
export function applyCandidateStep(
  store: Store,
  candidate: Candidate,
  now: Date,
  seen?: Map<string, string>,
): AppliedCandidate {
  // Consult the ledger before touching the domain: a rejected candidate must not
  // apply (ADR-0004). Throwing here rolls the whole propose.batch transaction
  // back (all-or-nothing), so a rejected member can't half-commit the batch.
  assertNotRejected(store, candidate);
  const { id, status } = resolveCandidateTarget(store, candidate, seen);
  if (status === "applied") {
    const persisted = appendEvent(store.connection.sqlite, candidateToEvent(candidate, id), now);
    applyEvent(store.connection.sqlite, persisted);
    seen?.set(candidate.candidateId, id);
  }
  return { candidateId: candidate.candidateId, kind: candidate.kind, entityId: id, status };
}

/**
 * Apply approved candidates, appending one event per *new* candidate. A
 * candidate whose ledger row is already `applied` (same candidateId — the
 * proposal round-trip) is skipped, making re-application of the same approved
 * set a no-op; a *distinct* candidate with an equal title (different
 * provenance / mode / rationale) mints a fresh entity id and applies (#435).
 * The host must have obtained human approval before calling.
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
  // In-call dedupe (candidateId → minted id): the same candidate listed twice
  // in one call must not append twice even when it has no ledger row.
  const seen = new Map<string, string>();

  for (const candidate of candidates) {
    const { id, status } = resolveCandidateTarget(store, candidate, seen);
    if (status === "applied") {
      store.record(candidateToEvent(candidate, id), now);
      seen.set(candidate.candidateId, id);
    }
    results.push({
      candidateId: candidate.candidateId,
      kind: candidate.kind,
      entityId: id,
      status,
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
