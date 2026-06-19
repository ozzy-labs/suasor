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

/** One resolved author handle (the `(connector, handle)` identity, ADR-0022). */
export interface AuthorHandle {
  connector: string;
  handle: string;
}

/**
 * Extract the author handle for a record of `connector`, reading the connector's
 * author key out of `meta`. Returns `null` when the connector has no author
 * mapping, or the value is missing / blank / non-string — so callers simply skip
 * recording an identity (best-effort, never throws).
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
  return { connector, handle };
}
