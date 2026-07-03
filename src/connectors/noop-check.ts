/**
 * Pre-sync no-op config detection (Issue #187, ADR-0007).
 *
 * A connector slice can be *enabled* (a `[connectors.<name>]` section exists and
 * is not `enabled = false`) yet still ingest nothing because its scope is empty:
 * github with no `repos` and `notifications = "off"`, box with no `folders`,
 * local with no `roots`, web with no `urls`, google/ms-graph with empty
 * `resources`, notion with no `databases` and `pages = false`, jira with no
 * `projects` and no `jql`. Without a hint the sync just reports `0 observed` and the user has
 * to inspect the DB to realize their config never had a target (the failure mode
 * called out in the issue).
 *
 * `noopWarning` inspects a connector's config slice (validated against the
 * connector's own Zod schema for shape parity with `loadConfig`) and returns a
 * human-readable warning when the slice resolves to "enabled but no ingest
 * target", or `null` otherwise. It is a *warning only* — callers print it to
 * stderr before sync and do **not** change the exit code (the run still succeeds
 * with 0 observed; ADR-0027 exit-code semantics are unchanged).
 *
 * Import-clean: this module imports only the per-connector Zod schemas (each
 * connector module is import-clean at the top level — `zod` + contract types —
 * so importing one for its schema pulls no heavy SDK; the SDK stays behind the
 * lazy `import` inside `sync`). The schemas are imported statically here because
 * the function is synchronous and runs once per connector before sync, where the
 * extra parse cost is negligible.
 */

import { BoxConnectorConfig } from "./box.ts";
import type { ConnectorConfig } from "./contract.ts";
import { GithubConnectorConfig } from "./github.ts";
import { GoogleConnectorConfig } from "./google.ts";
import { JiraConnectorConfig } from "./jira.ts";
import { LocalConnectorConfig } from "./local.ts";
import { MsGraphConnectorConfig } from "./ms-graph.ts";
import { NotionConnectorConfig } from "./notion.ts";
import { SlackConnectorConfig } from "./slack.ts";
import { WebConnectorConfig } from "./web.ts";

/**
 * Per-connector no-op detectors. Each receives the raw config slice, parses it
 * with the connector's own schema (so defaults / coercion match `loadConfig`),
 * and returns a warning string when the resolved config has no ingest target, or
 * `null` otherwise. A connector without a detector here is assumed to always have
 * a target (e.g. it ingests a fixed stream) and never warns.
 *
 * The schema `parse` can throw on a malformed slice, but that path is unreachable
 * in practice: callers run `loadConfig` first, which already validates the slice
 * and fails fast (#162). Defensive callers can still treat a throw as "no
 * warning" — see {@link noopWarning}.
 */
const DETECTORS: Record<string, (slice: ConnectorConfig) => string | null> = {
  github(slice) {
    const cfg = GithubConnectorConfig.parse(slice ?? {});
    if (cfg.repos.length === 0 && cfg.notifications === "off") {
      return "repos unset and notifications=off — nothing to ingest (set repos in config, or set notifications to all/repos)";
    }
    return null;
  },
  box(slice) {
    const cfg = BoxConnectorConfig.parse(slice ?? {});
    if (cfg.folders.length === 0) {
      return "folders unset — nothing to ingest (set folders in config)";
    }
    return null;
  },
  local(slice) {
    const cfg = LocalConnectorConfig.parse(slice ?? {});
    if (cfg.roots.length === 0) {
      return "roots unset — nothing to ingest (set roots in config)";
    }
    return null;
  },
  web(slice) {
    const cfg = WebConnectorConfig.parse(slice ?? {});
    if (cfg.urls.length === 0) {
      return "urls unset — nothing to ingest (set urls in config)";
    }
    return null;
  },
  google(slice) {
    const cfg = GoogleConnectorConfig.parse(slice ?? {});
    if (cfg.resources.length === 0) {
      return "resources unset — nothing to ingest (set resources in config)";
    }
    return null;
  },
  "ms-graph"(slice) {
    const cfg = MsGraphConnectorConfig.parse(slice ?? {});
    if (cfg.resources.length === 0) {
      return "resources unset — nothing to ingest (set resources in config)";
    }
    return null;
  },
  notion(slice) {
    const cfg = NotionConnectorConfig.parse(slice ?? {});
    // A target exists if any database is configured or standalone-page discovery
    // is on (the default). Both off = nothing to ingest.
    if (cfg.databases.length === 0 && !cfg.pages) {
      return "databases unset and pages=false — nothing to ingest (set databases in config, or set pages to true)";
    }
    return null;
  },
  jira(slice) {
    const cfg = JiraConnectorConfig.parse(slice ?? {});
    // An explicit `jql` is its own target (it overrides per-project queries).
    // Otherwise a target exists only when `projects` is non-empty.
    if (cfg.projects.length === 0 && (cfg.jql ?? "") === "") {
      return "projects unset and jql unset — nothing to ingest (set projects in config, or specify jql)";
    }
    return null;
  },
  slack(slice) {
    const cfg = SlackConnectorConfig.parse(slice ?? {});
    // Multi-workspace shape (ADR-0014) wins when present and non-empty: it has a
    // target if any workspace declares channels.
    const workspaces = cfg.workspaces ?? {};
    const aliases = Object.keys(workspaces);
    if (aliases.length > 0) {
      const anyChannels = aliases.some((alias) => (workspaces[alias]?.channels?.length ?? 0) > 0);
      return anyChannels
        ? null
        : "none of the workspaces have channels set — nothing to ingest (set channels for each workspace — get ids with `suasor slack conversations`)";
    }
    // Flat/default workspace: a target exists when `channels` is non-empty.
    if (cfg.channels.length === 0) {
      return "channels unset — nothing to ingest (set channels in config — get ids with `suasor slack conversations`)";
    }
    return null;
  },
};

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
  const detect = DETECTORS[name];
  if (!detect) return null;
  try {
    return detect(slice ?? {});
  } catch {
    return null;
  }
}
