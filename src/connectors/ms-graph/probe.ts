/**
 * Microsoft Graph per-resource reachability probes for `ms-graph auth test`
 * (ADR-0049, Issue #478).
 *
 * ms-graph is the connector the scope layer cannot serve at all: the app-only
 * client-credentials token reports `.default`, which resolves the application
 * permissions server-side and never enumerates them, so every readiness row was
 * `N/A (scopes not enumerated)` (Issue #194). A read-only GET per configured
 * resource replaces that N/A with a fact — and it is scoped to the configured
 * `user`, so a mistyped UPN surfaces as a 404 here instead of as an empty sync.
 *
 * `user` is required and non-empty by the time these specs are built (ADR-0051
 * removed the `"me"` default, which was only ever resolvable on a delegated
 * token and 404'd under the app-only flow this connector uses). The caller
 * reports an unset `user` as an unprobed row rather than probing a placeholder.
 *
 * Import-clean (ADR-0007): no Graph SDK / MSAL — plain URLs handed to the shared
 * `fetch`-only probe runner.
 */
import type { ResourceProbeSpec } from "../resource-probe.ts";

/** Graph v1.0 base — the same host the connector's SDK client talks to. */
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

/**
 * Build the probe targets for the configured `resources`, in a stable display
 * order. Unknown resource names are skipped (forward-compatible with a config
 * naming a resource this model does not map yet).
 *
 * @param resources configured `[connectors.ms-graph].resources` entries.
 * @param user configured `[connectors.ms-graph].user` (the mailbox / drive the
 *   app-only credential reads). Must be non-empty; an empty value yields no
 *   specs rather than a probe of some invented placeholder.
 */
export function msGraphProbeSpecs(
  resources: ReadonlySet<string>,
  user: string,
): ResourceProbeSpec[] {
  if (user.length === 0) return [];
  const u = encodeURIComponent(user);
  const specs: ResourceProbeSpec[] = [];
  if (resources.has("mail")) {
    specs.push({
      resource: "mail",
      what: `mailbox of "${user}"`,
      url: `${GRAPH_BASE}/users/${u}/messages?$top=1&$select=id`,
    });
  }
  if (resources.has("calendar")) {
    specs.push({
      resource: "calendar",
      what: `calendar of "${user}"`,
      url: `${GRAPH_BASE}/users/${u}/calendar?$select=id`,
    });
  }
  if (resources.has("files")) {
    specs.push({
      resource: "files",
      what: `OneDrive of "${user}"`,
      url: `${GRAPH_BASE}/users/${u}/drive?$select=id`,
    });
  }
  if (resources.has("teams")) {
    specs.push({
      resource: "teams",
      // `getAllMessages`, not the plain `/chats` collection: they sit behind
      // different permissions (Chat.Read.All + protected-API consent vs
      // Chat.ReadBasic.All), so probing the cheaper one would report REACHABLE
      // for a credential that cannot actually read a single message.
      what: `Teams chat messages of "${user}"`,
      url: `${GRAPH_BASE}/users/${u}/chats/getAllMessages?$top=1`,
    });
  }
  return specs;
}
