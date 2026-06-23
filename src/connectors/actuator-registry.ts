/**
 * Actuator registry (ADR-0036). Maps a task-home destination to a **lazy loader**
 * for its actuator factory, so neither registering nor listing actuators imports
 * any SDK — the SDK is pulled only when an actuator is actually built to publish
 * or act (import-clean, mirrors {@link ./registry.ts}).
 *
 * Independent of the connector registry: read (Connector) and write (Actuator)
 * are separate capabilities (ADR-0036 §2). GitHub ships first; Jira / Slack land
 * behind their own entries once their write APIs are wired (Slack after a spike,
 * ADR-0036 §1).
 */
import type { TaskDestination } from "../events/types.ts";
import type { ActuatorFactory } from "./actuator.ts";

/** Lazy loader returning an actuator's factory (SDK imported inside the factory). */
type ActuatorLoader = () => Promise<ActuatorFactory>;

/** Registered actuators, by destination → lazy factory loader. */
const REGISTRY: Partial<Record<TaskDestination, ActuatorLoader>> = {
  github: async () => {
    const { createGithubActuator } = await import("./github-actuator.ts");
    return (config) => createGithubActuator(config);
  },
  jira: async () => {
    const { createJiraActuator } = await import("./jira-actuator.ts");
    return (config) => createJiraActuator(config);
  },
  slack: async () => {
    const { createSlackListsActuator } = await import("./slack-lists-actuator.ts");
    return (config) => createSlackListsActuator(config);
  },
};

/** Destinations with a registered actuator (cheap; loads no SDK). */
export function actuatorDestinations(): TaskDestination[] {
  return Object.keys(REGISTRY).sort() as TaskDestination[];
}

/** Whether a destination has a registered (implemented) actuator. */
export function hasActuator(destination: string): destination is TaskDestination {
  return destination in REGISTRY;
}

/**
 * Build an actuator for a destination from its config slice. The actuator's
 * module (and its SDK) is imported here for the first time.
 *
 * @throws {Error} when the destination has no registered actuator.
 */
export async function loadActuator(destination: string, config: Record<string, unknown>) {
  const loader = REGISTRY[destination as TaskDestination];
  if (!loader) {
    throw new Error(
      `no actuator for destination: ${destination} (available: ${actuatorDestinations().join(", ") || "none"})`,
    );
  }
  const factory = await loader();
  return factory(config);
}
