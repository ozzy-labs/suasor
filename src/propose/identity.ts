/**
 * Apply-time entity-identity resolution for task / decision writes (#435,
 * [boundary/propose-1]).
 *
 * `entityId` (id.ts) is a pure content hash, and projection rows are never
 * deleted — so if the content hash alone named the entity, a task with a given
 * title and empty provenance ("経費精算", "call the dentist") could be created
 * exactly once in the store's lifetime. Identity is therefore split in two:
 *
 *   - **Idempotency** is scoped to the proposal round-trip (`candidateId`
 *     against the proposals ledger — see apply.ts), not to the domain entity.
 *   - **Entity ids** are minted at apply time: the content-derived base id is
 *     used while free, and disambiguated with a `-2`, `-3`, … suffix when
 *     occupied, so identically-titled entities can coexist.
 *
 * The minted id is baked into the appended event, so replay stays
 * deterministic (ADR-0002) — probing happens only on the write path, never in
 * the reducer. The suffix sequence is gap-free by construction (a suffixed id
 * exists only if every earlier id in the sequence exists), which lets the
 * probe walk ids until the first free slot instead of pattern-scanning.
 */
import type { Database } from "bun:sqlite";
import type { Candidate } from "./candidates.ts";
import { entityId } from "./id.ts";

/** Task lifecycle states that no longer occupy the "live duplicate" slot. */
export const TERMINAL_TASK_STATES = ["completed", "dropped"] as const;

/** A live (non-terminal) task sharing the exact content fingerprint. */
export interface TaskDuplicate {
  taskId: string;
  /** Lifecycle state of the duplicate (proposed / open / in_progress). */
  state: string;
  /** When the duplicate was last touched (ISO 8601). */
  updatedAt: string;
}

/** n-th id in a base id's minting sequence (1-based: base, base-2, base-3, …). */
function nthId(base: string, n: number): string {
  return n === 1 ? base : `${base}-${n}`;
}

/**
 * Mint a fresh, unoccupied entity id for a `task` / `decision` candidate:
 * walk the base id's minting sequence and return the first id with no
 * projection row. Other kinds pass through to the content-derived `entityId`
 * (their idempotence contract is unchanged — see apply.ts).
 */
export function mintEntityId(sqlite: Database, candidate: Candidate): string {
  if (candidate.kind !== "task" && candidate.kind !== "decision") return entityId(candidate);
  const table = candidate.kind === "task" ? "tasks" : "decisions";
  const base = entityId(candidate);
  for (let n = 1; ; n++) {
    const id = nthId(base, n);
    if (sqlite.query(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) === null) return id;
  }
}

/**
 * Resolve a task write against the existing content-equal rows (task.create /
 * inbox.triage): walk the minting sequence for the content's base id and
 * report both the first free id and the most recently updated *live*
 * (non-terminal) duplicate, if any. Terminal rows (completed / dropped) do not
 * block re-creation — a long-done "経費精算" must not make the title
 * unusable forever (#435).
 */
export function resolveTaskIdentity(
  sqlite: Database,
  content: { title: string; sourceExternalIds: string[] },
): { freeId: string; liveDuplicate: TaskDuplicate | null } {
  const base = entityId({
    kind: "task",
    candidateId: "resolve",
    title: content.title,
    sourceExternalIds: content.sourceExternalIds,
  });
  let liveDuplicate: TaskDuplicate | null = null;
  for (let n = 1; ; n++) {
    const id = nthId(base, n);
    const row = sqlite
      .query<{ id: string; state: string; updated_at: string }, [string]>(
        "SELECT id, state, updated_at FROM tasks WHERE id = ?",
      )
      .get(id);
    if (row === null) return { freeId: id, liveDuplicate };
    if (TERMINAL_TASK_STATES.includes(row.state as (typeof TERMINAL_TASK_STATES)[number])) {
      continue;
    }
    // Keep the most recently updated live duplicate (the one a host would
    // plausibly reopen / point the user at).
    if (liveDuplicate === null || row.updated_at > liveDuplicate.updatedAt) {
      liveDuplicate = { taskId: row.id, state: row.state, updatedAt: row.updated_at };
    }
  }
}
