/**
 * Detect `local` connector roots that sit inside a cloud-sync folder whose API
 * connector is also enabled (Issue #514).
 *
 * The deployment ADR-0023 names as the local connector's reason to exist — an
 * OS-synced Box / OneDrive / Google Drive mount, read as plain files, alongside
 * the same service's API connector — double-ingests every overlapping file
 * under two identities (`local:<sha1(path)>` and `box:file:<id>`). That
 * duplicates source rows, FTS entries, embeddings and therefore search hits,
 * and it is worst with extraction enabled, since both routes then carry the
 * full extracted text.
 *
 * The analogous Slack overlap (shared channels, ADR-0038) has a doctor check;
 * this one had none, so the duplication was invisible until someone noticed the
 * same document twice in a result list.
 *
 * **Heuristic by construction.** Mount names are environment-dependent and
 * users rename folders, so this recognises the conventional locations and
 * nothing more. It warns; it never fails a check or changes an exit code, and
 * the message says which two things to reconcile rather than prescribing one.
 */

/** A cloud-sync folder shape: the connector that would also ingest it via API. */
interface SyncFolderPattern {
  /** Connector whose API would ingest the same files. */
  readonly connector: string;
  /** Human label used in the warning. */
  readonly label: string;
  /**
   * Mount folder names (case-insensitive). Matched **per path segment**, either
   * exactly or followed by a separator character, because real mounts carry a
   * suffix: `OneDrive - Acme`, `OneDrive-Personal`, `Box Sync`. Segment matching
   * is also what keeps `sandbox` and `boxes` from tripping the `box` pattern.
   */
  readonly names: readonly string[];
}

/**
 * Conventional sync-folder locations per connector. Deliberately short: a
 * false positive costs a confusing warning, so only shapes that are strongly
 * associated with one service are listed.
 */
const SYNC_FOLDERS: readonly SyncFolderPattern[] = [
  {
    connector: "box",
    label: "Box Drive",
    names: ["box"],
  },
  {
    connector: "ms-graph",
    label: "OneDrive",
    names: ["onedrive"],
  },
  {
    connector: "google",
    label: "Google Drive",
    names: ["google drive", "googledrive"],
  },
];

/** One detected overlap between a local root and an enabled API connector. */
export interface LocalOverlap {
  /** The `[connectors.local].roots` entry that looks like a sync mount. */
  readonly root: string;
  /** Connector whose API also ingests those files. */
  readonly connector: string;
  /** Human-readable one-liner for the doctor check. */
  readonly message: string;
}

/** Lowercased path segments, separator-normalized (handles Windows paths too). */
function segments(path: string): string[] {
  return path
    .replaceAll("\\", "/")
    .toLowerCase()
    .split("/")
    .filter((part) => part.length > 0);
}

/**
 * True when a path segment names this mount: an exact match, or the name
 * followed by a separator character. `OneDrive - Acme` and `OneDrive-Personal`
 * match `onedrive`; `sandbox` and `boxes` do not match `box`.
 */
function segmentNames(segment: string, name: string): boolean {
  if (segment === name) return true;
  if (!segment.startsWith(name)) return false;
  const next = segment.charAt(name.length);
  return next === " " || next === "-" || next === "_";
}

/**
 * Find local roots that overlap an enabled API connector's own scope.
 *
 * Pure over its inputs (no filesystem access): the caller supplies the roots
 * and the set of enabled connectors, so this is unit-testable without a home
 * directory full of cloud mounts.
 */
export function detectLocalOverlaps(
  roots: readonly string[],
  enabledConnectors: readonly string[],
): LocalOverlap[] {
  const enabled = new Set(enabledConnectors);
  const overlaps: LocalOverlap[] = [];
  for (const root of roots) {
    const parts = segments(root);
    for (const pattern of SYNC_FOLDERS) {
      if (!enabled.has(pattern.connector)) continue;
      const hit = parts.some((part) => pattern.names.some((name) => segmentNames(part, name)));
      if (!hit) continue;
      overlaps.push({
        root,
        connector: pattern.connector,
        message:
          `local root ${root} looks like a ${pattern.label} mount while the ` +
          `'${pattern.connector}' connector is also enabled — the same files are ` +
          "ingested twice under different ids (duplicate sources, FTS rows, " +
          "embeddings and search hits). Keep one route: drop the root, or disable " +
          `the ${pattern.connector} connector.`,
      });
    }
  }
  return overlaps;
}
