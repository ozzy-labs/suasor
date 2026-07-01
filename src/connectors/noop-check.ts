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
      return "repos 未設定かつ notifications=off — 取り込み対象なし（config の repos を設定するか notifications を all/repos に）";
    }
    return null;
  },
  box(slice) {
    const cfg = BoxConnectorConfig.parse(slice ?? {});
    if (cfg.folders.length === 0) {
      return "folders 未設定 — 取り込み対象なし（config の folders を設定）";
    }
    return null;
  },
  local(slice) {
    const cfg = LocalConnectorConfig.parse(slice ?? {});
    if (cfg.roots.length === 0) {
      return "roots 未設定 — 取り込み対象なし（config の roots を設定）";
    }
    return null;
  },
  web(slice) {
    const cfg = WebConnectorConfig.parse(slice ?? {});
    if (cfg.urls.length === 0) {
      return "urls 未設定 — 取り込み対象なし（config の urls を設定）";
    }
    return null;
  },
  google(slice) {
    const cfg = GoogleConnectorConfig.parse(slice ?? {});
    if (cfg.resources.length === 0) {
      return "resources 未設定 — 取り込み対象なし（config の resources を設定）";
    }
    return null;
  },
  "ms-graph"(slice) {
    const cfg = MsGraphConnectorConfig.parse(slice ?? {});
    if (cfg.resources.length === 0) {
      return "resources 未設定 — 取り込み対象なし（config の resources を設定）";
    }
    return null;
  },
  notion(slice) {
    const cfg = NotionConnectorConfig.parse(slice ?? {});
    // A target exists if any database is configured or standalone-page discovery
    // is on (the default). Both off = nothing to ingest.
    if (cfg.databases.length === 0 && !cfg.pages) {
      return "databases 未設定かつ pages=false — 取り込み対象なし（config の databases を設定するか pages を true に）";
    }
    return null;
  },
  jira(slice) {
    const cfg = JiraConnectorConfig.parse(slice ?? {});
    // An explicit `jql` is its own target (it overrides per-project queries).
    // Otherwise a target exists only when `projects` is non-empty.
    if (cfg.projects.length === 0 && (cfg.jql ?? "") === "") {
      return "projects 未設定かつ jql 未設定 — 取り込み対象なし（config の projects を設定するか jql を指定）";
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
        : "workspaces のどの channel も未設定 — 取り込み対象なし（各 workspace の channels を設定 — id は `suasor slack conversations` で取得）";
    }
    // Flat/default workspace: a target exists when `channels` is non-empty.
    if (cfg.channels.length === 0) {
      return "channels 未設定 — 取り込み対象なし（config の channels を設定 — id は `suasor slack conversations` で取得）";
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
