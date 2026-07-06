/**
 * Pre-sync no-op config detection (Issue #187, ADR-0007).
 *
 * A connector slice can be *enabled* (a `[connectors.<name>]` section exists and
 * is not `enabled = false`) yet still ingest nothing because its scope is empty:
 * github with no `repos` and `notifications = "off"`, box with no `folders`,
 * local with no `roots`, web with no `urls`, google/ms-graph with empty
 * `resources`, notion with no `databases` and `pages = false`, jira with no
 * `projects` and no `jql`. Without a hint the sync just reports `0 observed` and
 * the user has to inspect the DB to realize their config never had a target (the
 * failure mode called out in the issue).
 *
 * `noopWarning` inspects a connector's config slice (validated against the
 * connector's own Zod schema for shape parity with `loadConfig`) and returns a
 * human-readable warning when the slice resolves to "enabled but no ingest
 * target", or `null` otherwise. It is a *warning only* — callers print it to
 * stderr before sync and do **not** change the exit code (the run still succeeds
 * with 0 observed; ADR-0027 exit-code semantics are unchanged).
 *
 * The per-connector scope-emptiness predicate is no longer a table in this file:
 * it moved onto each connector's manifest (`ConnectorManifest.noopWarning`,
 * Issue #440), so a new connector declares it in one place and the completeness
 * test enforces it. This module is now a thin lookup over the manifest registry.
 *
 * Import-clean: this module imports only the manifest aggregation (which eager-
 * imports the per-connector manifests — plain data + Zod schemas, no heavy SDK,
 * mirroring the discipline the DETECTORS table used to rely on). The manifest
 * module is never on the registry / config / MCP-serve hot path.
 */

import type { ConnectorConfig } from "./contract.ts";
import { connectorManifest } from "./manifest.ts";

/**
 * Return a no-op warning for a connector's config slice, or `null` when the
 * slice resolves to at least one ingest target (or the connector has no no-op
 * notion). The message is the *body* only — callers prefix it with the connector
 * name (e.g. `warning: github: <message>`), matching the existing `onWarn`
 * formatting in the sync commands.
 *
 * Best-effort: a slice that fails to parse (already rejected upstream by
 * `loadConfig`, #162) yields `null` rather than throwing, so this never turns a
 * pre-sync advisory into a hard error.
 */
export function noopWarning(name: string, slice: ConnectorConfig): string | null {
  const detect = connectorManifest(name)?.noopWarning;
  if (!detect) return null;
  try {
    return detect(slice ?? {});
  } catch {
    return null;
  }
}
