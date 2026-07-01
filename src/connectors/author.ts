/**
 * Author-handle extraction from a source record's connector metadata (ADR-0022 /
 * ADR-0007). The sync service uses this to emit `PersonIdentityObserved` so the
 * person projection can resolve "who" across connectors.
 *
 * Each connector stores its author under its own `meta` key (github → `author`
 * login, slack → `user` `Uxxxx`). This module is the single place that maps a
 * connector name to that key, so the reducer/sync stay decoupled from per-
 * connector meta shapes. A connector with no author concept (or a record with no
 * author) yields `null` and no identity is recorded — handle resolution is
 * best-effort and never blocks ingest.
 *
 * Import-clean: plain data + a pure function; pulls no connector SDK.
 */

/** The `meta` key each connector stores its author handle under (ADR-0022). */
const AUTHOR_META_KEY: Record<string, string> = {
  github: "author",
  slack: "user",
};

/**
 * The `meta` key each connector stores its author *display name* under, when it
 * resolves one at sync time (ADR-0037 §3). Only connectors that enrich the
 * author with a human-readable name appear here (slack → `userName`, resolved
 * via `users.info`). A missing / blank value is treated as "not resolved" so the
 * person projection keeps its id-derived name (ADR-0037 §6 degrade).
 */
const AUTHOR_DISPLAY_NAME_META_KEY: Record<string, string> = {
  slack: "userName",
};

/** One resolved author handle (the `(connector, handle)` identity, ADR-0022). */
export interface AuthorHandle {
  connector: string;
  handle: string;
  /**
   * Human-readable display name for the handle, when the connector resolved one
   * at sync time (ADR-0037 §2/§3). Absent when the connector has no name concept
   * or resolution degraded (empty / missing meta value) — callers then emit no
   * `displayName`, leaving the person projection's last-write-wins name intact.
   */
  displayName?: string;
}

/**
 * Extract the author handle for a record of `connector`, reading the connector's
 * author key out of `meta`. Returns `null` when the connector has no author
 * mapping, or the value is missing / blank / non-string — so callers simply skip
 * recording an identity (best-effort, never throws).
 *
 * When the connector also resolved a display name at sync time (ADR-0037 §3), it
 * is read from the connector's display-name meta key and attached as
 * `displayName`. A missing / blank / non-string name is left unset (degrade).
 */
export function authorFromMeta(
  connector: string,
  meta: Record<string, unknown>,
): AuthorHandle | null {
  const key = AUTHOR_META_KEY[connector];
  if (key === undefined) return null;
  const raw = meta[key];
  if (typeof raw !== "string") return null;
  const handle = raw.trim();
  if (handle === "") return null;
  const author: AuthorHandle = { connector, handle };
  const nameKey = AUTHOR_DISPLAY_NAME_META_KEY[connector];
  if (nameKey !== undefined) {
    const rawName = meta[nameKey];
    if (typeof rawName === "string" && rawName.trim() !== "") author.displayName = rawName.trim();
  }
  return author;
}
