/**
 * Google per-resource reachability probes for `google auth test` (ADR-0049,
 * Issue #478).
 *
 * Google *does* enumerate granted scopes, so the scope layer already answers
 * "was the permission asked for". What it cannot answer is whether the resource
 * the connector will actually read is reachable — most importantly the
 * **configured `calendarIds`**: a mistyped id passes every scope check and then
 * ingests nothing (ADR-0007 "no silent wrong answer"). Each probe therefore
 * targets the same surface the connector's `sync` reads, with the smallest page
 * the API allows. Every configured calendar is probed, not just the first: each
 * one is an independent ingest target, so probing one and reporting for all
 * would be exactly the kind of extrapolation ADR-0049 refuses.
 *
 * Import-clean (ADR-0007): no `googleapis` — plain URLs handed to the shared
 * `fetch`-only probe runner.
 */
import type { ResourceProbeSpec } from "../resource-probe.ts";

/**
 * Build the probe targets for the configured `resources`, in a stable display
 * order. Unknown resource names are skipped (forward-compatible with a config
 * naming a resource this model does not map yet).
 *
 * @param resources configured `[connectors.google].resources` entries.
 * @param calendarIds configured `[connectors.google].calendarIds` — every
 *   calendar the connector reads. An empty list yields no calendar spec; the
 *   caller reports that as "not probed" rather than inventing a `primary`
 *   fallback that would probe a calendar nothing ingests (ADR-0051).
 */
export function googleProbeSpecs(
  resources: ReadonlySet<string>,
  calendarIds: readonly string[],
): ResourceProbeSpec[] {
  const specs: ResourceProbeSpec[] = [];
  if (resources.has("drive")) {
    specs.push({
      resource: "drive",
      what: "Drive file list",
      url: "https://www.googleapis.com/drive/v3/files?pageSize=1&fields=files(id)",
    });
  }
  if (resources.has("gmail")) {
    specs.push({
      resource: "gmail",
      // The message list, not `users/me/profile`: the profile call is satisfied
      // by narrower scopes, so it would report REACHABLE for a credential that
      // cannot list a single message.
      what: "Gmail message list",
      url: "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=1",
    });
  }
  if (resources.has("calendar")) {
    // The *configured* calendars, not a generic list call: these are the ids sync
    // reads, so a typo surfaces here as a 404 instead of as an empty ingest.
    for (const id of new Set(calendarIds)) {
      specs.push({
        resource: "calendar",
        what: `calendar "${id}"`,
        url: `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(id)}`,
      });
    }
  }
  return specs;
}
