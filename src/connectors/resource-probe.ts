/**
 * Per-resource **reachability** probes for `<connector> auth test` (ADR-0049,
 * Issue #478; the resource layer above ADR-0011's scope-layer capability model).
 *
 * A granted scope says the operator *asked* for a permission; it never says the
 * resource is actually readable with the credential that is stored. The two
 * questions have different confidence, and for the app-only connectors the scope
 * question cannot be answered at all (Microsoft's client-credentials token
 * reports `.default`, which resolves application permissions server-side), so
 * every ms-graph readiness row was `N/A (scopes not enumerated)`. This module
 * answers the second question directly: one cheap read-only GET per **configured**
 * resource, reporting what the API said.
 *
 * The verdict vocabulary is deliberately three-valued and never guesses:
 * - `reachable` — the API returned 2xx for that resource. A fact.
 * - `unreachable` — the API returned a definite negative for that resource
 *   (401 / 403 = permission, 404 = the configured id does not exist for this
 *   credential). Also a fact, and the ADR-0007 "no silent wrong answer" case:
 *   a mistyped `calendarId` / `user` ingests nothing, silently, today.
 * - `unknown` — anything else (transport failure, timeout, 5xx). Reported as
 *   `unknown`, **never** collapsed into `reachable`, because an unverified
 *   premise is exactly what a health check exists to surface (same discipline as
 *   doctor's `storage.disk_encryption`).
 *
 * Import-clean (ADR-0007): global `fetch` only — no connector SDK — wrapped in
 * the shared {@link fetchWithRetry} so a transient 429/5xx is retried with
 * `Retry-After` honoured (Issue #269). Access tokens are passed in and never
 * echoed: only the HTTP status and the API's own error code reach the output.
 */
import {
  DEFAULT_CONNECTOR_TIMEOUT_MS,
  type FetchWithRetryOptions,
  fetchWithRetry,
} from "../util/retry.ts";

/** Confidence-preserving verdict for one resource probe. */
export type ResourceReachabilityState = "reachable" | "unreachable" | "unknown";

/** One probed resource's outcome. */
export interface ResourceReachability {
  /** Config `resources` entry this row is about (e.g. `mail`). */
  readonly resource: string;
  /** Verdict — see {@link ResourceReachabilityState}. */
  readonly state: ResourceReachabilityState;
  /** Human detail: what was probed and what the API said (never a secret). */
  readonly detail: string;
}

/** One resource's probe target: a label plus the read-only URL to GET. */
export interface ResourceProbeSpec {
  /** Config `resources` entry (the row key). */
  readonly resource: string;
  /** Short description of what is being read (shown in the detail). */
  readonly what: string;
  /** Fully-qualified read-only URL. */
  readonly url: string;
}

/** One probe round-trip, decoupled from `fetch` so tests inject a fake. */
export type ResourceProbeTransport = (
  spec: ResourceProbeSpec,
  accessToken: string,
) => Promise<{ status: number; body: Record<string, unknown> }>;

/**
 * Build the default transport: a bearer-authenticated GET run through
 * {@link fetchWithRetry} (429/5xx retried, `Retry-After` honoured). A per-attempt
 * timeout is defaulted so a hung host cannot pin the check.
 */
export function makeDefaultProbeTransport(
  retry: FetchWithRetryOptions = {},
): ResourceProbeTransport {
  const opts = { timeoutMs: DEFAULT_CONNECTOR_TIMEOUT_MS, ...retry };
  return async (spec, accessToken) => {
    const res = await fetchWithRetry(
      spec.url,
      { method: "GET", headers: { Authorization: `Bearer ${accessToken}` } },
      opts,
    );
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      // Non-JSON body → leave empty; the status drives the verdict.
    }
    return { status: res.status, body };
  };
}

const defaultTransport: ResourceProbeTransport = makeDefaultProbeTransport();

/**
 * Pull the API's own error code/message out of a JSON error body, for both
 * shapes the probed surfaces use: Google's `{error:{message,status}}` (also the
 * OAuth `{error, error_description}` form) and Graph's `{error:{code,message}}`.
 * Returns an empty string when nothing usable is present — the caller then falls
 * back to the bare HTTP status rather than inventing a reason.
 */
export function apiErrorDetail(body: Record<string, unknown>): string {
  const error = body.error;
  if (typeof error === "string") {
    const description = body.error_description;
    return typeof description === "string" && description.length > 0 ? description : error;
  }
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const code = typeof record.status === "string" ? record.status : record.code;
    const message = record.message;
    const parts = [
      typeof code === "string" || typeof code === "number" ? String(code) : "",
      typeof message === "string" ? message : "",
    ].filter((p) => p.length > 0);
    if (parts.length > 0) return parts.join(": ");
  }
  return "";
}

/**
 * Run one resource probe and classify the result.
 *
 * 401/403/404 are definite negatives (`unreachable`) and carry the API's own
 * error text so the operator can tell "permission not granted" from "that id
 * does not exist". Everything else — a transport throw, a timeout, a 5xx that
 * outlived the retries — is `unknown`: the probe could not establish the fact,
 * and saying `reachable` there would be a guess.
 */
export async function probeResource(
  spec: ResourceProbeSpec,
  accessToken: string,
  transport: ResourceProbeTransport = defaultTransport,
): Promise<ResourceReachability> {
  let status: number;
  let body: Record<string, unknown>;
  try {
    ({ status, body } = await transport(spec, accessToken));
  } catch (cause) {
    return {
      resource: spec.resource,
      state: "unknown",
      detail: `could not probe ${spec.what}: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  if (status >= 200 && status < 300) {
    return { resource: spec.resource, state: "reachable", detail: `${spec.what} readable` };
  }
  const reason = apiErrorDetail(body);
  const suffix = reason.length > 0 ? ` (${reason})` : "";
  if (status === 401 || status === 403 || status === 404) {
    const cause =
      status === 404
        ? "not found — check the configured id"
        : "permission denied — grant the read permission and re-consent";
    return {
      resource: spec.resource,
      state: "unreachable",
      detail: `${spec.what}: HTTP ${status}, ${cause}${suffix}`,
    };
  }
  return {
    resource: spec.resource,
    state: "unknown",
    detail: `${spec.what}: HTTP ${status}, could not determine reachability${suffix}`,
  };
}

/**
 * Probe every spec in order (serial — a handful of resources, and serial keeps
 * the load and the output order predictable).
 */
export async function probeResources(
  specs: readonly ResourceProbeSpec[],
  accessToken: string,
  transport: ResourceProbeTransport = defaultTransport,
): Promise<ResourceReachability[]> {
  const rows: ResourceReachability[] = [];
  for (const spec of specs) rows.push(await probeResource(spec, accessToken, transport));
  return rows;
}
