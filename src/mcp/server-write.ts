/**
 * MCP write-tool surface (ADR-0004, docs/design/mcp-surface.md) — the HITL half
 * of the agent boundary, extracted verbatim from the former monolithic
 * `server.ts`.
 *
 * Every tool here carries `readOnlyHint: false` so MCP hosts gate it behind
 * human approval (no auto-apply, ADR-0004 / FR-PRO-2). Structured tool errors
 * (ADR-0031) are preserved exactly. These tools are registered only when a
 * writable `Store` + config are supplied; the registration order matches the
 * pre-split server so the tool catalog stays byte-identical.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runConnectorSyncTool } from "../connectors/mcp-tool.ts";
import { createComposer } from "../export/compose.ts";
import { DraftExportError, draftExport } from "../export/draft-export.ts";
import { sourceForget } from "../forget/source-forget.ts";
import { proposeApply } from "../propose/apply.ts";
import { proposeBatch } from "../propose/batch.ts";
import {
  CandidateInput as CandidateInputSchema,
  Candidate as CandidateSchema,
  MODE_ALLOWED_KINDS,
  PROPOSE_MODES,
  ProposeMode as ProposeModeSchema,
} from "../propose/candidates.ts";
import { commitmentDismiss, commitmentReopen, commitmentResolve } from "../propose/commitment.ts";
import { decisionRecord } from "../propose/decision-record.ts";
import { proposeFeedback } from "../propose/feedback.ts";
import { persistProposals } from "../propose/generate.ts";
import { inboxAdd } from "../propose/inbox-add.ts";
import { inboxTriage, TRIAGE_ACTIONS, TriageError } from "../propose/inbox-triage.ts";
import { linkAdd } from "../propose/link-add.ts";
import { linkRemove } from "../propose/link-remove.ts";
import { personMerge } from "../propose/person-merge.ts";
import { personSplit } from "../propose/person-split.ts";
import { proposeReject } from "../propose/reject.ts";
import { taskCreate } from "../propose/task-create.ts";
import { taskAct, taskPublish } from "../propose/task-publish.ts";
import { taskUpdate } from "../propose/task-update.ts";
import { toolError, toToolError } from "./errors.ts";
import { isoDateTime, jsonResult, type McpServerDeps } from "./server-shared.ts";

/** The non-null `write` half of {@link McpServerDeps}. */
type WriteDeps = NonNullable<McpServerDeps["write"]>;

/** Register every write/HITL tool onto `server` in the original order. */
export function registerWriteTools(server: McpServer, write: WriteDeps): void {
  // --- connector.sync: read-only ingest into the local store (WRITE / HITL). ---
  // Registered only when a writable store is supplied. `readOnlyHint: false`
  // marks it as a write tool so hosts gate it behind human approval (ADR-0004);
  // it calls the same `syncConnector` service as the `suasor <connector> sync`
  // CLI (Issue #10 D5).
  server.registerTool(
    "connector.sync",
    {
      title: "Connector sync (ingest)",
      description:
        "Run a read-only connector ingest pass into the local store (e.g. " +
        "github). Write tool: requires human approval — no auto-apply. Incremental " +
        "via fingerprint/cursor delta; pass cursor=null to force a full re-scan.",
      inputSchema: {
        connector: z.string().min(1).describe('Connector to run (e.g. "github").'),
        cursor: z
          .string()
          .nullable()
          .optional()
          .describe("Resume cursor; omit to resume, null to re-scan fully."),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ connector, cursor }) => {
      try {
        const outcome = await runConnectorSyncTool(
          { connector, ...(cursor !== undefined ? { cursor } : {}) },
          { store: write.store, config: write.config },
        );
        return jsonResult(outcome);
      } catch (error) {
        // An unknown connector is a structured input error so the host can
        // tell "you named a connector that doesn't exist" from a sync failure.
        if (error instanceof Error && error.message.startsWith("unknown connector")) {
          return toolError({
            code: "UNKNOWN_CONNECTOR",
            message: error.message,
            hint: "Use one of the known connectors (see `suasor connectors` / the error's `known:` list).",
          });
        }
        return toToolError(error);
      }
    },
  );

  // --- propose.generate: frame host-produced content into HITL candidates. ---
  // No persistence: it only validates the items against the mode's allowed
  // candidate kinds and assigns each a stable id. The host LLM does the
  // reasoning (ADR-0006); approval + apply happen separately (ADR-0004).
  const modeList = PROPOSE_MODES.join(" / ");
  server.registerTool(
    "propose.generate",
    {
      title: "Propose (generate candidates)",
      description:
        `Frame host-produced reply/task/decision/triage candidates into a HITL ` +
        `proposal (modes: ${modeList}). Validates and id-stamps the candidates, ` +
        `then records them in the proposal ledger as 'pending' (visible via ` +
        `propose.list) so a human can approve a subset (propose.apply) or reject ` +
        `(propose.reject). No domain entity is written until apply; no auto-apply ` +
        `(ADR-0004).`,
      inputSchema: {
        mode: ProposeModeSchema.describe(`Generation mode (${modeList}).`),
        candidates: z
          .array(CandidateInputSchema)
          .min(1)
          .describe(
            "Host-produced candidate items. Allowed kinds per mode: " +
              PROPOSE_MODES.map((m) => `${m} → ${MODE_ALLOWED_KINDS[m].join("/")}`).join("; "),
          ),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ mode, candidates }) => {
      const result = persistProposals(write.store, { mode, candidates });
      return jsonResult(result);
    },
  );

  // --- propose.apply: persist approved candidates as events (idempotent). ---
  // Write tool (HITL): turns approved candidates into domain events. Re-applying
  // the same candidate is a no-op (content-derived ids), so it is idempotent.
  server.registerTool(
    "propose.apply",
    {
      title: "Propose (apply candidates)",
      description:
        "Persist approved candidates (from propose.generate) as domain events. " +
        "Write tool: requires human approval — no auto-apply (ADR-0004). " +
        "Idempotent: candidates whose entity already exists are skipped.",
      inputSchema: {
        candidates: z
          .array(CandidateSchema)
          .min(1)
          .describe("Approved, id-stamped candidates to apply."),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ candidates }) => {
      const result = proposeApply(write.store, { candidates });
      return jsonResult(result);
    },
  );

  // --- propose.reject: reject a pending candidate with a reason (Issue #89). ---
  // Write tool (HITL): the reject half of the approve/reject loop. Flips a
  // pending proposal to `rejected` so it is no longer offered for approval.
  // Idempotent: re-rejecting is a no-op; an applied/missing candidate is
  // reported, not mutated (a rejected candidate cannot be applied).
  server.registerTool(
    "propose.reject",
    {
      title: "Propose (reject candidate)",
      description:
        "Reject a pending proposal candidate (from propose.generate) with an " +
        "optional reason, recording the decision in the proposal ledger. " +
        "Write tool: requires human approval — no auto-apply (ADR-0004). " +
        "Acts only on a pending candidate; an applied or missing one is reported, " +
        "not changed. Idempotent: re-rejecting is a no-op.",
      inputSchema: {
        candidateId: z.string().min(1).describe("Candidate id from propose.generate."),
        reason: z.string().optional().describe("Why the candidate is rejected (recorded)."),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ candidateId, reason }) => {
      const result = proposeReject(write.store, {
        candidateId,
        ...(reason !== undefined ? { reason } : {}),
      });
      return jsonResult(result);
    },
  );

  // --- propose.batch: apply + reject in one atomic RPC (Issue #197). ---
  // Write tool (HITL): folds the approve/reject loop's two RPCs into one
  // operation list committed under a single transaction (all-or-nothing). Each
  // op reuses the same per-op logic/semantics as propose.apply / propose.reject
  // (idempotent apply, state-dependent reject); apply ops carry the full
  // candidate (apply needs the payload), reject ops carry just the candidate id.
  server.registerTool(
    "propose.batch",
    {
      title: "Propose (batch apply/reject)",
      description:
        "Apply and/or reject HITL proposal candidates in one RPC, committed " +
        "under a single transaction (atomic, all-or-nothing). Each operation is " +
        "{ action: 'apply', candidate } or { action: 'reject', candidateId, " +
        "reason? }. Reuses propose.apply / propose.reject semantics (idempotent " +
        "apply skips existing entities; reject acts only on pending candidates). " +
        "Write tool: requires human approval — no auto-apply (ADR-0004).",
      inputSchema: {
        operations: z
          .array(
            z.discriminatedUnion("action", [
              z.object({
                action: z.literal("apply"),
                candidate: CandidateSchema.describe("Approved, id-stamped candidate to apply."),
              }),
              z.object({
                action: z.literal("reject"),
                candidateId: z.string().min(1).describe("Candidate id from propose.generate."),
                reason: z.string().optional().describe("Why the candidate is rejected (recorded)."),
              }),
            ]),
          )
          .min(1)
          .describe("Mixed apply/reject operations, applied atomically in order."),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ operations }) => {
      const result = proposeBatch(write.store, {
        operations: operations.map((op) =>
          op.action === "reject"
            ? {
                action: "reject" as const,
                candidateId: op.candidateId,
                ...(op.reason !== undefined ? { reason: op.reason } : {}),
              }
            : op,
        ),
      });
      return jsonResult(result);
    },
  );

  // --- proposal.feedback: record a regeneration hint on a pending candidate. ---
  // Write tool (HITL): the third option beyond apply/reject (Issue #279). Records
  // a human's note on a still-pending candidate WITHOUT changing its state (stays
  // pending), so the next propose.generate can use it as a hint. Appends
  // ProposalFeedback; acts only on a pending row (applied/rejected/missing are
  // reported in the result, not mutated). Re-recording overwrites (latest wins).
  server.registerTool(
    "proposal.feedback",
    {
      title: "Propose (feedback on candidate)",
      description:
        "Record a regeneration hint (reason) on a pending proposal candidate " +
        "without applying or rejecting it (Issue #279) — the candidate stays " +
        "`pending` and the host can use the recorded reason to steer the next " +
        "propose.generate. Write tool: requires human approval — no auto-apply " +
        "(ADR-0004). Acts only on a pending candidate; an applied / rejected / " +
        "missing one is reported, not changed. Re-recording overwrites (latest wins).",
      inputSchema: {
        candidateId: z.string().min(1).describe("Candidate id from propose.generate."),
        reason: z.string().min(1).describe("Feedback note for the next regeneration."),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ candidateId, reason }) => {
      const result = proposeFeedback(write.store, { candidateId, reason });
      return jsonResult(result);
    },
  );

  // --- task.create: direct HITL task creation (Issue #12 追補 D2). ---
  // The human's own "add task" path (vs. model-suggested propose.*). Appends a
  // TaskProposed event → tasks projection. HITL, idempotent on content.
  server.registerTool(
    "task.create",
    {
      title: "Create task",
      description:
        "Create a task directly (appends TaskProposed → tasks projection). " +
        "Write tool: requires human approval — no auto-apply (ADR-0004). " +
        "Idempotent: re-creating the same task (title + provenance) is a no-op. " +
        "Optional dueDate / priority scheduling fields (ADR-0028).",
      inputSchema: {
        title: z.string().min(1).describe("Task title."),
        dueDate: isoDateTime.optional().describe("Optional due date (ISO 8601, ADR-0028)."),
        priority: z
          .enum(["low", "normal", "high"])
          .optional()
          .describe("Optional priority (low/normal/high, ADR-0028)."),
        sourceExternalIds: z
          .array(z.string().min(1))
          .optional()
          .describe("Source ids this task derives from (provenance)."),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ title, dueDate, priority, sourceExternalIds }) => {
      const result = taskCreate(write.store, {
        title,
        ...(dueDate !== undefined ? { dueDate } : {}),
        ...(priority !== undefined ? { priority } : {}),
        ...(sourceExternalIds !== undefined ? { sourceExternalIds } : {}),
      });
      return jsonResult(result);
    },
  );

  // --- task.update: advance a task's lifecycle state (HITL). ---
  // The transition half of the task lifecycle: task.create opens a task and
  // task.list reads it, but advancing to in_progress / completed / dropped
  // had no write surface. Appends TaskApplied → tasks projection. HITL,
  // idempotent (same-state is a no-op, missing task is reported not thrown).
  server.registerTool(
    "task.update",
    {
      title: "Update task state",
      description:
        "Transition a task's lifecycle state (open / in_progress / completed / " +
        "dropped) by appending TaskApplied → tasks projection. Optionally (re)set " +
        "dueDate / priority on the same call (ADR-0028). Write tool: requires " +
        "human approval — no auto-apply (ADR-0004). Idempotent: a same-state call " +
        "with no scheduling update is a no-op (unchanged); an unknown task is " +
        "reported missing.",
      inputSchema: {
        taskId: z.string().min(1).describe("Id of the task to transition."),
        state: z
          .enum(["open", "in_progress", "completed", "dropped"])
          .describe("Lifecycle state to move the task to."),
        dueDate: isoDateTime
          .optional()
          .describe("Optional due date to (re)set (ISO 8601, ADR-0028)."),
        priority: z
          .enum(["low", "normal", "high"])
          .optional()
          .describe("Optional priority to (re)set (low/normal/high, ADR-0028)."),
      },
      // openWorldHint: a state change on a *published* task egresses to its home
      // (ADR-0036 §3); unpublished tasks stay local. HITL either way.
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ taskId, state, dueDate, priority }) => {
      try {
        const result = await taskUpdate(
          write.store,
          {
            taskId,
            state,
            ...(dueDate !== undefined ? { dueDate } : {}),
            ...(priority !== undefined ? { priority } : {}),
          },
          new Date(),
          { config: write.config },
        );
        return jsonResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  // --- task.publish: 起票 a task to its single external home (ADR-0036). ---
  // Egress write (single-pane). Publishes a confirmed task to the configured
  // [tasks].home (GitHub Issues first) and appends a body-less TaskPublished.
  // HITL, openWorldHint (external I/O), idempotent on the deterministic taskId.
  server.registerTool(
    "task.publish",
    {
      title: "Publish task to external home",
      description:
        "Publish a confirmed task to its single external home ([tasks].home: " +
        "GitHub Issues / Jira / Slack List) and record TaskPublished (ADR-0036). " +
        "Egress write tool: requires human approval — no auto-apply (ADR-0004). " +
        "Idempotent: an already-published task is a no-op (returns existing).",
      inputSchema: {
        taskId: z.string().min(1).describe("Id of the task to publish."),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ taskId }) => {
      try {
        const result = await taskPublish(write.store, write.config, { taskId });
        return jsonResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  // --- task.act: lifecycle write-back to a published task's home (ADR-0036). ---
  // complete / reopen / comment issued to the external tool (the state authority);
  // appends a body-less TaskActionIssued. HITL, openWorldHint.
  server.registerTool(
    "task.act",
    {
      title: "Act on a published task",
      description:
        "Issue a lifecycle operation (complete / reopen / comment) to a published " +
        "task's external home and record TaskActionIssued (ADR-0036). The external " +
        "tool is the state authority; suasor reflects it back via read-back. " +
        "Egress write tool: requires human approval — no auto-apply (ADR-0004).",
      inputSchema: {
        taskId: z.string().min(1).describe("Id of the published task to act on."),
        action: z
          .enum(["complete", "reopen", "comment"])
          .describe("Lifecycle operation to issue to the external home."),
        body: z
          .string()
          .min(1)
          .optional()
          .describe("Comment body (required when action = comment)."),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ taskId, action, body }) => {
      try {
        const result = await taskAct(write.store, write.config, {
          taskId,
          action,
          ...(body !== undefined ? { body } : {}),
        });
        return jsonResult(result);
      } catch (error) {
        return toToolError(error);
      }
    },
  );

  // --- decision.record: direct HITL decision recording (Issue #88). ---
  // The decision counterpart to task.create: the human's own "log this
  // decision" path. Appends DecisionRecorded → decisions projection. HITL,
  // idempotent on content (title + provenance).
  server.registerTool(
    "decision.record",
    {
      title: "Record decision",
      description:
        "Record a decision directly (appends DecisionRecorded → decisions projection). " +
        "Write tool: requires human approval — no auto-apply (ADR-0004). " +
        "Idempotent: re-recording the same decision (title + provenance) is a no-op.",
      inputSchema: {
        title: z.string().min(1).describe("Decision title."),
        rationale: z.string().optional().describe("Why this decision was made."),
        sourceExternalIds: z
          .array(z.string().min(1))
          .optional()
          .describe("Source ids this decision derives from (provenance)."),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ title, rationale, sourceExternalIds }) => {
      const result = decisionRecord(write.store, {
        title,
        ...(rationale !== undefined ? { rationale } : {}),
        ...(sourceExternalIds !== undefined ? { sourceExternalIds } : {}),
      });
      return jsonResult(result);
    },
  );

  // --- inbox.add: capture an inbox item (Issue #88). ---
  // The capture half of the daily triage loop. Appends InboxItemTriaged in the
  // `open` state → inbox projection. HITL, idempotent on the captured source.
  server.registerTool(
    "inbox.add",
    {
      title: "Add inbox item",
      description:
        "Capture an inbox item referencing a source (appends InboxItemTriaged " +
        "in the `open` state → inbox projection). Write tool: requires human " +
        "approval — no auto-apply (ADR-0004). Idempotent: capturing the same " +
        "source twice is a no-op.",
      inputSchema: {
        sourceExternalId: z
          .string()
          .min(1)
          .describe("Source id the inbox item references (provenance)."),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ sourceExternalId }) => {
      const result = inboxAdd(write.store, { sourceExternalId });
      return jsonResult(result);
    },
  );

  // --- inbox.triage: resolve an open inbox item (Issue #88 state machine). ---
  // Moves an `open` item out of the inbox: task / decision creates the derived
  // entity + marks the item `done`; discard marks it `dismissed`. Only `open`
  // items may be triaged (invalid transitions are tool errors). HITL.
  const triageActions = TRIAGE_ACTIONS.join(" / ");
  server.registerTool(
    "inbox.triage",
    {
      title: "Triage inbox item",
      description:
        `Resolve an open inbox item (actions: ${triageActions}). \`task\` / ` +
        "`decision` create a derived task/decision from the item's source and " +
        "mark it `done`; `discard` marks it `dismissed`. Only `open` items may " +
        "be triaged. Write tool: requires human approval — no auto-apply (ADR-0004).",
      inputSchema: {
        inboxId: z.string().min(1).describe("Inbox item id to triage."),
        action: z.enum(TRIAGE_ACTIONS).describe(`Triage action (${triageActions}).`),
        title: z
          .string()
          .min(1)
          .optional()
          .describe("Title for the derived task/decision (required for task/decision)."),
        rationale: z.string().optional().describe("Rationale for the derived decision."),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ inboxId, action, title, rationale }) => {
      try {
        const result = inboxTriage(write.store, {
          inboxId,
          action,
          ...(title !== undefined ? { title } : {}),
          ...(rationale !== undefined ? { rationale } : {}),
        });
        return jsonResult(result);
      } catch (error) {
        // Invalid state-machine transitions surface as structured tool errors
        // (not a crash) so the host can branch on the code and show the user a
        // fix. A missing item → MISSING_ENTITY; a non-`open` item → INVALID_STATE.
        if (error instanceof TriageError) {
          const missing = error.message.includes("not found");
          return toolError({
            code: missing ? "MISSING_ENTITY" : "INVALID_STATE",
            message: error.message,
            hint: missing
              ? "Check the inbox id via inbox.list."
              : "Only an 'open' inbox item can be triaged; list open items via inbox.list.",
          });
        }
        return toToolError(error);
      }
    },
  );

  // --- link.add: create a manual provenance link (Issue #90). ---
  // The human/agent's own "relate these two entities" path, beyond the
  // reducer-derived edges. Appends a LinkAdded event → links projection with
  // the `manual_link` relation (graph.related / graph.expand then traverse it).
  // Idempotent on the directed endpoint pair; self-loops are rejected. HITL.
  server.registerTool(
    "link.add",
    {
      title: "Add manual link",
      description:
        "Create a manual provenance link (relation `manual_link`) between two " +
        "entities so graph.related / graph.expand can traverse it — beyond the " +
        "reducer-derived edges (derived_from / replies_to / references). Write " +
        "tool: requires human approval — no auto-apply (ADR-0004). Idempotent: " +
        "re-adding the same directed link is a no-op; a self-loop is rejected.",
      inputSchema: {
        fromKind: z.string().min(1).describe("Origin entity kind (e.g. task / decision / source)."),
        fromId: z.string().min(1).describe("Origin entity id."),
        toKind: z.string().min(1).describe("Target entity kind."),
        toId: z.string().min(1).describe("Target entity id."),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ fromKind, fromId, toKind, toId }) => {
      try {
        const result = linkAdd(write.store, { fromKind, fromId, toKind, toId });
        return jsonResult(result);
      } catch (error) {
        // A self-loop (or other invalid input) surfaces as a structured tool
        // error (INVALID_INPUT) so the host can show the rejection rather than
        // crash, and branch on the code.
        if (error instanceof Error) {
          return toolError({
            code: "INVALID_INPUT",
            message: error.message,
            hint: "from and to must be distinct entities (no self-loop).",
          });
        }
        return toToolError(error);
      }
    },
  );

  // --- link.remove: delete a manual provenance link by id (Issue #90). ---
  // Removal half of the manual-link pair. Appends a LinkRemoved event → the
  // row disappears from links (audit-able via the add/remove event pair). Only
  // manual links (carrying a link_id) are removable; removing a non-existent
  // link is a tool error so the host surfaces the mistake. HITL.
  server.registerTool(
    "link.remove",
    {
      title: "Remove manual link",
      description:
        "Remove a manual link by its id (the `linkId` returned by link.add). " +
        "Only manual links are removable — reducer-derived provenance edges are " +
        "owned by the reducer. Write tool: requires human approval — no " +
        "auto-apply (ADR-0004). Removing a non-existent link is a tool error.",
      inputSchema: {
        linkId: z.string().min(1).describe("Manual link id to remove (from link.add)."),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ linkId }) => {
      try {
        const result = linkRemove(write.store, { linkId });
        return jsonResult(result);
      } catch (error) {
        // Removing an absent link surfaces as a structured tool error
        // (MISSING_ENTITY) so the host can branch on the code and the user can
        // correct it.
        if (error instanceof Error) {
          return toolError({
            code: "MISSING_ENTITY",
            message: error.message,
            hint: "Only manual links are removable; find the linkId via graph.related (manual_link edges carry it).",
          });
        }
        return toToolError(error);
      }
    },
  );

  // --- person.merge: collapse two persons into one (ADR-0022, Issue #92). ---
  // Write half of identity resolution: the operator's explicit "same human"
  // action (no fuzzy auto-merge). Appends PersonsMerged → the source person's
  // identities reassign to the target. HITL; reversible via person.split.
  server.registerTool(
    "person.merge",
    {
      title: "Merge persons",
      description:
        "Merge two resolved persons into one: reassign every identity of the source " +
        "person to the target (ADR-0022). Operator-driven — there is no automatic " +
        "fuzzy de-duplication. Write tool: requires human approval — no auto-apply " +
        "(ADR-0004). Reversible via person.split. A self-merge or unknown source " +
        "person is a tool error.",
      inputSchema: {
        targetPersonId: z
          .string()
          .min(1)
          .describe("Person that survives and absorbs the other's identities."),
        sourcePersonId: z
          .string()
          .min(1)
          .describe("Person whose identities move to the target (emptied)."),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ targetPersonId, sourcePersonId }) => {
      try {
        const result = personMerge(write.store, { targetPersonId, sourcePersonId });
        return jsonResult(result);
      } catch (error) {
        // A self-merge is INVALID_INPUT; an unknown source person is
        // MISSING_ENTITY — structured so the host can branch + show a fix.
        if (error instanceof Error) {
          const missing = error.message.includes("unknown source person");
          return toolError({
            code: missing ? "MISSING_ENTITY" : "INVALID_INPUT",
            message: error.message,
            hint: missing
              ? "Check both person ids via person.list."
              : "target and source must be distinct persons (no self-merge).",
          });
        }
        return toToolError(error);
      }
    },
  );

  // --- person.split: move one identity off a person (ADR-0022, Issue #92). ---
  // Inverse of merge: detach a single (connector, handle) identity and bind it
  // to another person (default: its own content-derived person — "undo a wrong
  // merge"). Appends PersonSplit. HITL; reversible via person.merge.
  server.registerTool(
    "person.split",
    {
      title: "Split person identity",
      description:
        "Split one (connector, handle) identity off its current person into another " +
        "person (ADR-0022) — the inverse of person.merge, to correct an over-merge. " +
        "Omit newPersonId to send the identity to its own content-derived person. " +
        "Write tool: requires human approval — no auto-apply (ADR-0004). An unknown " +
        "identity is a tool error.",
      inputSchema: {
        connector: z.string().min(1).describe("Connector of the identity to move out."),
        handle: z.string().min(1).describe("Handle of the identity to move out."),
        newPersonId: z
          .string()
          .min(1)
          .optional()
          .describe("Target person id (default: the identity's own content-derived person)."),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ connector, handle, newPersonId }) => {
      try {
        const result = personSplit(write.store, {
          connector,
          handle,
          ...(newPersonId !== undefined ? { newPersonId } : {}),
        });
        return jsonResult(result);
      } catch (error) {
        // An unknown (connector, handle) identity is MISSING_ENTITY —
        // structured so the host can branch on the code and show a fix.
        if (error instanceof Error) {
          return toolError({
            code: "MISSING_ENTITY",
            message: error.message,
            hint: "Check the (connector, handle) identity via person.list.",
          });
        }
        return toToolError(error);
      }
    },
  );

  // --- commitment.resolve / .dismiss / .reopen: ledger lifecycle (ADR-0021). ---
  // The state-transition half of the commitment ledger. Extraction rides the
  // `commitment_scan` propose mode (→ CommitmentOpened); these three move a
  // commitment through its lifecycle. Each appends a Commitment* event. HITL,
  // status-reporting (no throw): a no-op/invalid/missing transition is reported
  // in the result so the host can surface it without a crash.
  server.registerTool(
    "commitment.resolve",
    {
      title: "Resolve commitment",
      description:
        "Mark an open commitment fulfilled (appends CommitmentResolved → open → " +
        "resolved). Write tool: requires human approval — no auto-apply (ADR-0004). " +
        "Idempotent: an already-resolved commitment is a no-op; a dismissed one is " +
        "reported invalid_state (reopen first); a missing one is reported missing.",
      inputSchema: {
        commitmentId: z.string().min(1).describe("Commitment id from commitment.list."),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ commitmentId }) => {
      const result = commitmentResolve(write.store, { commitmentId });
      return jsonResult(result);
    },
  );

  server.registerTool(
    "commitment.dismiss",
    {
      title: "Dismiss commitment",
      description:
        "Dismiss an open commitment as a false-positive / no longer relevant " +
        "(appends CommitmentDismissed → open → dismissed). Write tool: requires " +
        "human approval — no auto-apply (ADR-0004). Idempotent: an already-dismissed " +
        "commitment is a no-op; a resolved one is reported invalid_state (reopen " +
        "first); a missing one is reported missing.",
      inputSchema: {
        commitmentId: z.string().min(1).describe("Commitment id from commitment.list."),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ commitmentId }) => {
      const result = commitmentDismiss(write.store, { commitmentId });
      return jsonResult(result);
    },
  );

  server.registerTool(
    "commitment.reopen",
    {
      title: "Reopen commitment",
      description:
        "Move a resolved / dismissed commitment back to open (appends " +
        "CommitmentReopened). Write tool: requires human approval — no auto-apply " +
        "(ADR-0004). Idempotent: an already-open commitment is a no-op; a missing " +
        "one is reported missing.",
      inputSchema: {
        commitmentId: z.string().min(1).describe("Commitment id from commitment.list."),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ commitmentId }) => {
      const result = commitmentReopen(write.store, { commitmentId });
      return jsonResult(result);
    },
  );

  // --- source.forget: purge an ingested source locally (ADR-0026). ---
  // Redacts the body from the event log + purges projection/sidecar. HITL.
  server.registerTool(
    "source.forget",
    {
      title: "Forget source",
      description:
        "Purge an ingested source locally (ADR-0026): redact its body from the " +
        "event log and delete it from the projection / FTS / vectors. Keeps a " +
        "body-less audit record. Write tool: requires human approval — no " +
        "auto-apply (ADR-0004). Idempotent: re-forgetting is a no-op; an " +
        "unknown source is reported missing.",
      inputSchema: {
        externalId: z.string().min(1).describe("Source id to forget."),
        reason: z.string().min(1).optional().describe("Optional audit reason."),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ externalId, reason }) => {
      const result = sourceForget(write.store, {
        externalId,
        ...(reason !== undefined ? { reason } : {}),
      });
      return jsonResult(result);
    },
  );

  // --- draft.export: write a draft to a local file (ADR-0025). ---
  // Local-only (no egress, no source write-back), sandboxed to [export].dir,
  // body-less DraftExported audit event. HITL.
  server.registerTool(
    "draft.export",
    {
      title: "Export draft to file",
      description:
        "Write a draft (reply/handoff/announcement/plan text) to a local file " +
        "under the export sandbox ([export].dir). Local-only: never sends and " +
        "never writes back to a source (ADR-0025). Write tool: requires human " +
        "approval — no auto-apply (ADR-0004). filename is a basename; collisions " +
        "get a numeric suffix.",
      inputSchema: {
        content: z.string().describe("Draft text to write."),
        filename: z.string().min(1).describe("Target filename (basename only)."),
        format: z
          .enum(["md", "txt", "docx", "pptx", "xlsx"])
          .describe("Export format (docx/pptx/xlsx need [export].composition)."),
        sourceExternalId: z
          .string()
          .min(1)
          .optional()
          .describe("Source the draft derives from (provenance)."),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ content, filename, format, sourceExternalId }) => {
      const dir = write.config.export?.dir;
      if (!dir) {
        // Structured config error (ADR-0031): the host can branch on the code
        // and tell the user exactly which config to set, instead of a bare
        // string that reads like an internal crash.
        return toolError({
          code: "EXPORT_DIR_NOT_CONFIGURED",
          message: "export dir is not configured ([export].dir)",
          hint: "Set [export].dir in your config to a writable sandbox directory (ADR-0025).",
        });
      }
      try {
        const localRoots = Array.isArray(write.config.connectors.local?.roots)
          ? (write.config.connectors.local.roots as string[])
          : [];
        const composer = write.config.export?.composition
          ? createComposer(write.config.export.composition)
          : null;
        const result = await draftExport(
          write.store,
          { content, filename, format, ...(sourceExternalId ? { sourceExternalId } : {}) },
          { exportDir: dir, localRoots, composer },
        );
        return jsonResult(result);
      } catch (error) {
        // Invalid filename / export dir overlapping a local root surfaces as a
        // structured INVALID_INPUT error rather than tearing down the call.
        if (error instanceof DraftExportError) {
          return toolError({
            code: "INVALID_INPUT",
            message: error.message,
            hint: "Use a basename-only filename and keep [export].dir outside any [connectors.local].roots (ADR-0025).",
          });
        }
        return toToolError(error);
      }
    },
  );
}
