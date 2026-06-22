/**
 * Actuator contract (ADR-0036 — task external-home management).
 *
 * Where {@link ./contract.ts `Connector`} is the **read-only** ingest contract
 * (ADR-0007: never writes back to the source), an `Actuator` is the *separate*
 * write capability ADR-0036 introduces: it publishes a task to an external home
 * (GitHub Issues / Jira / Slack List) and issues lifecycle operations
 * (complete / reopen / comment) against the published item.
 *
 * The two are intentionally distinct interfaces with independent registries: a
 * source is either read-only, or read + actuator. Keeping `Connector` untouched
 * preserves the ADR-0007 read contract verbatim — egress lives only here.
 *
 * Like connectors, this module is **import-clean**: types only, no SDK. Concrete
 * actuators (e.g. `./github-actuator.ts`) lazy-import their SDK inside methods.
 */

import type { TaskDestination } from "../events/types.ts";

/** The minimal task shape an actuator needs to publish (ADR-0036). */
export interface PublishableTask {
  /**
   * Deterministic task id (title + provenance derived). Used as the **client-side
   * idempotency key**: an actuator MUST make `publish` idempotent on it (search
   * by marker before create, or pass it to an idempotency-capable API) so a
   * retried/timed-out publish never double-creates (ADR-0036 §4).
   */
  readonly taskId: string;
  /** Human title → external item title. */
  readonly title: string;
  /**
   * Optional body text (provenance links to originating comms). May be sent to
   * the external tool, but is never folded into the body-less audit event.
   */
  readonly body?: string;
  /** Optional due date (ISO 8601), mapped to the tool's due field when supported. */
  readonly dueDate?: string | null;
  /** Optional priority (low/normal/high), mapped to a label/field when supported. */
  readonly priority?: string | null;
}

/** Lifecycle operations an actuator can issue against a published item. */
export type ActuatorAction =
  | { readonly kind: "complete" }
  | { readonly kind: "reopen" }
  | { readonly kind: "comment"; readonly body: string };

/** Context handed to actuator calls (mirrors {@link ./contract.ts SyncContext}). */
export interface ActuatorContext {
  /**
   * Resolve a named secret (a **write-scoped** token — distinct from the read
   * connector's token, ADR-0036 §4). Returns `null` when not configured; the
   * actuator surfaces a structured `ACTUATOR_NOT_CONFIGURED` error upstream.
   */
  secret(name: string): Promise<string | null>;
  /** Optional non-fatal warning channel (e.g. unsupported field skipped). */
  readonly onWarn?: (message: string) => void;
}

/** Result of a successful `publish`. */
export interface PublishResult {
  /** Cross-source-unique id of the created (or re-used, idempotent) external item. */
  readonly externalId: string;
}

/**
 * A write capability against one external home. Concrete actuators lazy-import
 * their SDK inside these methods to stay registration-import-clean (ADR-0036).
 */
export interface Actuator {
  /** Destination key this actuator serves (matches {@link TaskDestination}). */
  readonly destination: TaskDestination;
  /**
   * Publish (起票) the task to the external home. MUST be idempotent on
   * `task.taskId` (ADR-0036 §4): a re-publish returns the existing item's
   * `externalId` rather than creating a duplicate.
   */
  publish(task: PublishableTask, ctx: ActuatorContext): Promise<PublishResult>;
  /**
   * Issue a lifecycle operation against an already-published item. The external
   * tool remains the state authority; this is the single-pane write-back path
   * (ADR-0036 §4). No-op semantics are the actuator's responsibility (e.g.
   * completing an already-closed item).
   */
  act(externalId: string, action: ActuatorAction, ctx: ActuatorContext): Promise<void>;
}

/** A factory that builds an actuator from its config slice (lazy SDK inside). */
export type ActuatorFactory = (config: Record<string, unknown>) => Actuator;
