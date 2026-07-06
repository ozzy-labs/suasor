/**
 * Sidecar-egress loopback gating (Issue #436, ADR-0003 content-minimization).
 *
 * Several optional sidecars receive **full content** over HTTP: the `[export]
 * .composition` (pandoc) sidecar gets the whole draft body, `[extraction]`
 * (markitdown) gets the whole document bytes, and the `[embedding]` **ollama**
 * sidecar gets the body text. Each schema accepts any `z.string().url()`, so a
 * non-local `baseUrl` silently turns a "local, no-egress" path into remote egress
 * — `draft.export` even advertises "Local-only: never sends" while its Office
 * path could POST to an arbitrary host.
 *
 * This module is the single source of truth for **which sidecars egress** and
 * **whether a `baseUrl` is loopback**. The loader uses it to *reject* a
 * non-loopback endpoint that has not opted in (`<section>.allowRemote = true`),
 * and `collectConfigWarnings` uses it to *disclose* an opted-in remote endpoint
 * (mirroring the embedding-API key-gate: the external egress is opt-in and always
 * surfaced, never silent — ADR-0007). The external `openai` / `voyage` embedding
 * backends are **remote by design** (key-gated, disclosed via the key-readiness
 * warning), so the loopback gate applies only to the local-sidecar backend
 * (`ollama`), never to those.
 */

/** Config sections whose sidecar receives full body/document bytes over HTTP. */
export type SidecarSection = "embedding" | "extraction" | "export.composition";

/**
 * The loopback hosts a sidecar `baseUrl` may target without opting into remote
 * egress. `127.0.0.0/8` covers the whole IPv4 loopback block, not just
 * `127.0.0.1`. Documentation constant (the actual test is {@link isLoopbackUrl}).
 */
export const SIDECAR_LOOPBACK_ALLOWLIST = ["localhost", "127.0.0.0/8", "::1"] as const;

/** One **active** sidecar endpoint that egresses content over HTTP. */
export interface SidecarEndpoint {
  /** The config section (also the `<section>.baseUrl` warning key prefix). */
  section: SidecarSection;
  /** The `<section>.allowRemote` config key that opts into a non-loopback host. */
  allowRemoteKey: string;
  /** The effective sidecar base URL. */
  baseUrl: string;
  /** What is sent to the sidecar (for the disclosure message). */
  content: string;
  /** Whether `<section>.allowRemote` is opted in. */
  allowRemote: boolean;
  /** Whether `baseUrl` targets a loopback host (per {@link isLoopbackUrl}). */
  loopback: boolean;
}

/**
 * Structural subset of {@link import("./schema.ts").Config} the egress check
 * inspects. Kept minimal so callers can pass a resolved `Config` (a structural
 * superset) and tests a small literal. `extraction` / `export` are optional so a
 * pre-schema literal without those sections is valid input.
 */
export interface SidecarEgressInput {
  embedding: { backend: string; baseUrl?: string; allowRemote?: boolean };
  extraction?: { backend: string; baseUrl?: string; allowRemote?: boolean };
  export?: { composition?: { backend?: string; baseUrl?: string; allowRemote?: boolean } };
}

/**
 * True when `baseUrl` targets a loopback host (localhost / 127.0.0.0/8 / ::1).
 * An unparseable URL returns `false` (fail-safe: treat as remote so it is gated).
 */
export function isLoopbackUrl(baseUrl: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname;
  } catch {
    return false;
  }
  // `URL.hostname` keeps IPv6 brackets (`[::1]`); strip them before comparing.
  const host = hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  // IPv4 loopback block 127.0.0.0/8 (127.0.0.1 and the rest of the range).
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

function endpoint(
  section: SidecarSection,
  baseUrl: string,
  content: string,
  allowRemote: boolean,
): SidecarEndpoint {
  return {
    section,
    allowRemoteKey: `${section}.allowRemote`,
    baseUrl,
    content,
    allowRemote,
    loopback: isLoopbackUrl(baseUrl),
  };
}

/**
 * The **active** content-egressing sidecars in `input`, in config order
 * (embedding → extraction → export.composition). An endpoint is included only
 * when its backend is the built local-sidecar backend and a `baseUrl` is set:
 *
 * - `embedding` — only `ollama` (openai/voyage are remote-by-design external
 *   APIs, key-gated and disclosed via the key-readiness warning; not loopback-gated).
 * - `extraction` — only `markitdown`.
 * - `export.composition` — only `pandoc`.
 *
 * Each endpoint carries its `loopback` / `allowRemote` flags so callers decide:
 * the loader rejects `!loopback && !allowRemote`; warnings disclose `!loopback`.
 */
export function collectSidecarEndpoints(input: SidecarEgressInput): SidecarEndpoint[] {
  const endpoints: SidecarEndpoint[] = [];

  if (input.embedding.backend === "ollama" && typeof input.embedding.baseUrl === "string") {
    endpoints.push(
      endpoint(
        "embedding",
        input.embedding.baseUrl,
        "body text",
        input.embedding.allowRemote === true,
      ),
    );
  }

  if (input.extraction?.backend === "markitdown" && typeof input.extraction.baseUrl === "string") {
    endpoints.push(
      endpoint(
        "extraction",
        input.extraction.baseUrl,
        "document bytes",
        input.extraction.allowRemote === true,
      ),
    );
  }

  const composition = input.export?.composition;
  if (composition?.backend === "pandoc" && typeof composition.baseUrl === "string") {
    endpoints.push(
      endpoint(
        "export.composition",
        composition.baseUrl,
        "the draft body",
        composition.allowRemote === true,
      ),
    );
  }

  return endpoints;
}
