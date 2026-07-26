/**
 * Removed connector config shapes, and the check that turns each one into a
 * migration instruction (ADR-0042 決定 9 for Slack, ADR-0051 for google).
 *
 * A removed key is not a typo. Strict slice validation would call it an
 * "unrecognized key", which is both unhelpful (it does not say what to write
 * instead) and — for `validate-config --fix`, whose safe-fix policy is "drop
 * unknown keys" — **actively dangerous**: dropping `calendarId = "work@x"`
 * silently reverts the ingest target to the `calendarIds` default, which is
 * exactly the "an existing config comes to mean something it does not say"
 * outcome the migration exists to prevent. So every consumer of connector slices
 * (`loadConfig`, `validate-config`) runs these first and stops short of the
 * strict pass for that connector.
 *
 * The table is **lazy** rather than a `ConnectorManifest` field on purpose:
 * `manifest.ts` eagerly imports every connector module and is deliberately kept
 * off the config / registry / MCP-serve path (see its module header), so
 * declaring this there would drag all of them onto config load.
 */

/** Throws a `ConfigError` when a slice still uses the connector's removed shape. */
export type LegacyShapeRejector = (slice: Record<string, unknown>) => void;

/** Connector name → lazily-loaded rejector. Absent ⇒ nothing was ever removed. */
const LEGACY_SHAPE_REJECTORS: Record<string, () => Promise<LegacyShapeRejector>> = {
  slack: async () => (await import("../connectors/slack.ts")).rejectLegacySlackConfig,
  google: async () => (await import("../connectors/google.ts")).rejectLegacyGoogleConfig,
};

/**
 * The removed-shape check for a connector, or `null` when it has none. Resolving
 * the module is deferred to the call so a config with no google / slack slice
 * never imports those connectors.
 */
export async function legacyShapeRejector(name: string): Promise<LegacyShapeRejector | null> {
  const load = LEGACY_SHAPE_REJECTORS[name];
  return load ? await load() : null;
}

/** Connector names that declare a removed shape (sorted) — for tests / docs. */
export function legacyShapeConnectorNames(): string[] {
  return Object.keys(LEGACY_SHAPE_REJECTORS).sort();
}
