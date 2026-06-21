/**
 * Box folder discovery for `box folders` (ADR-0030; the box port of Slack's
 * `slack conversations` / github's `github repos` / google's `google calendars`
 * discovery).
 *
 * Enumerates the subfolders reachable from a root (`GET /2.0/folders/<id>/items`,
 * folder entries only) so the operator can discover the folder `id`s the box
 * connector reads without hand-hunting them from the Box Web UI — closing the
 * typo→silent-0-results gap (ADR-0007 "no silent wrong answer"). Box folders form
 * a tree, so the listing recurses (one level at a time) and the CLI renders an
 * id/name tree; the paste-ready `[connectors.box]` block carries every discovered
 * id (the plural `folders = [...]` the connector config expects).
 *
 * Import-clean (ADR-0007): no `box-typescript-sdk-gen`. The default transport
 * uses the global `fetch` (same pattern as `src/connectors/box/auth.ts`), wrapped
 * in the shared {@link fetchWithRetry} so a transient 429/5xx (with `Retry-After`
 * honoured) is retried rather than aborting the sweep mid-pagination (Issue #269).
 * Building the connector / CLI registry never pulls the SDK. The token is never
 * echoed in thrown errors.
 */

import {
  DEFAULT_CONNECTOR_TIMEOUT_MS,
  type FetchWithRetryOptions,
  fetchWithRetry,
} from "../../util/retry.ts";
import { type ConfigBlockEntry, renderConnectorConfigBlock } from "../onboard/config-block.ts";

/** One folder surfaced for the discovery CLI (flattened, depth-tagged). */
export interface BoxFolder {
  /** Folder id — a value `[connectors.box].folders` accepts. */
  readonly id: string;
  /** Folder name. */
  readonly name: string;
  /** Depth below the root (root's direct children are depth 0). */
  readonly depth: number;
  /** Parent folder id (the root id for depth-0 folders). */
  readonly parentId: string;
}

/** Result of a discovery sweep: the visible folders in pre-order (tree order). */
export interface FoldersResult {
  /** The root folder id the sweep walked from. */
  readonly root: string;
  /** Discovered folders, in depth-first pre-order (display order). */
  readonly folders: BoxFolder[];
}

export interface ListFoldersOptions {
  /** Root folder id to walk from (Box root is "0"). Defaults to "0". */
  readonly root?: string;
  /** Substring filter over folder name + id (case-insensitive). */
  readonly filter?: string;
  /**
   * Max depth to recurse (0 = only the root's direct children). Defaults to a
   * single level so a huge tree is not walked by accident; raise to descend.
   */
  readonly maxDepth?: number;
  /** Transport override (tests inject a fake; default lazy-`fetch`). */
  readonly transport?: BoxFoldersTransport;
  /**
   * Called once per fetched page so a CLI can render an indeterminate progress
   * counter while the sweep runs. Best-effort: any throw is ignored so progress
   * reporting never fails the listing.
   */
  readonly onProgress?: () => void;
}

/** One `GET /2.0/folders/<id>/items` page fetch, decoupled from `fetch` for tests. */
export type BoxFoldersTransport = (request: {
  token: string;
  /** Folder id whose items are being listed. */
  folderId: string;
  /** Marker for the next page, or `undefined` for the first page. */
  marker?: string;
}) => Promise<{ status: number; body: unknown }>;

/** Per-page ceiling (Box's max for `limit` on folder items). */
const PAGE_LIMIT = 1000;
/** Default recursion depth (root's direct children only). */
const DEFAULT_MAX_DEPTH = 0;

/**
 * Build the default transport: a `GET /2.0/folders/<id>/items` reading folder
 * entries, run through {@link fetchWithRetry} so a transient 429/5xx is retried
 * rather than aborting the sweep mid-pagination (Issue #269). `retry` is injectable
 * (`fetchImpl` / `sleep`) so a test can drive "429 → Retry-After → success" with
 * no real waiting.
 */
export function makeDefaultTransport(retry: FetchWithRetryOptions = {}): BoxFoldersTransport {
  // Default a per-attempt timeout so a hung host cannot pin a bulk-sync worker
  // (Issue #269); a caller-supplied `timeoutMs` still wins.
  const opts = { timeoutMs: DEFAULT_CONNECTOR_TIMEOUT_MS, ...retry };
  return async ({ token, folderId, marker }) => {
    const params = new URLSearchParams({
      usemarker: "true",
      limit: String(PAGE_LIMIT),
      fields: "id,name,type",
    });
    if (marker) params.set("marker", marker);
    const res = await fetchWithRetry(
      `https://api.box.com/2.0/folders/${encodeURIComponent(folderId)}/items?${params.toString()}`,
      { method: "GET", headers: { Authorization: `Bearer ${token}` } },
      opts,
    );
    let body: unknown = {};
    try {
      body = await res.json();
    } catch {
      // Non-JSON error body (e.g. an HTML 5xx) → leave empty; status drives it.
      body = {};
    }
    return { status: res.status, body };
  };
}

const defaultTransport: BoxFoldersTransport = makeDefaultTransport();

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

interface RawEntry {
  type?: string;
  id?: string;
  name?: string;
}

/** One page of folder children, decoded from a raw items response. */
interface FolderPage {
  readonly subfolders: { id: string; name: string }[];
  readonly nextMarker?: string;
}

/**
 * Fetch one page of a folder's items, keeping only the subfolders.
 *
 * @throws {Error} when the GET returns a non-2xx (message carries the HTTP
 *   status + Box `message`, never the token).
 */
async function fetchPage(
  transport: BoxFoldersTransport,
  token: string,
  folderId: string,
  marker: string | undefined,
): Promise<FolderPage> {
  const { status, body } = await transport({
    token,
    folderId,
    ...(marker ? { marker } : {}),
  });
  const obj = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (status < 200 || status >= 300) {
    const message = asString(obj.message) || `HTTP ${status}` || "unknown error";
    throw new Error(`box GET /2.0/folders/${folderId}/items failed: ${status} ${message}`);
  }
  const entries = Array.isArray(obj.entries) ? (obj.entries as RawEntry[]) : [];
  const subfolders = entries
    .filter((e) => e.type === "folder" && typeof e.id === "string" && e.id.length > 0)
    .map((e) => ({ id: e.id as string, name: asString(e.name) }));
  // Box's marker pagination returns the next marker as `next_marker`.
  return { subfolders, nextMarker: asString(obj.next_marker) || undefined };
}

/** List every subfolder of a folder (walking all pages). */
async function listChildren(
  transport: BoxFoldersTransport,
  token: string,
  folderId: string,
  tick: () => void,
): Promise<{ id: string; name: string }[]> {
  const children: { id: string; name: string }[] = [];
  let marker: string | undefined;
  do {
    const page = await fetchPage(transport, token, folderId, marker);
    tick();
    for (const sub of page.subfolders) children.push(sub);
    marker = page.nextMarker;
  } while (marker);
  return children;
}

/**
 * Enumerate the subfolders reachable from a root, depth-first to `maxDepth`.
 *
 * Folders are returned in pre-order (a parent immediately precedes its
 * children) so the CLI can render a tree without re-sorting. Siblings are sorted
 * a-z by name (case-insensitive) for a stable, scannable listing.
 *
 * @throws {Error} when any `GET /2.0/folders/<id>/items` returns a non-2xx
 *   (message carries the HTTP status + Box message, never the token).
 */
export async function listFolders(
  token: string,
  options: ListFoldersOptions = {},
): Promise<FoldersResult> {
  const transport = options.transport ?? defaultTransport;
  const root = options.root && options.root.length > 0 ? options.root : "0";
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  // Best-effort progress tick: a throw in the reporter must not fail the sweep.
  const tick = () => {
    try {
      options.onProgress?.();
    } catch {}
  };

  const folders: BoxFolder[] = [];

  // Depth-first pre-order walk. A simple recursion keeps a parent immediately
  // before its descendants (the order the tree renderer relies on).
  const walk = async (parentId: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    const children = await listChildren(transport, token, parentId, tick);
    children.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    for (const child of children) {
      folders.push({ id: child.id, name: child.name, depth, parentId });
      await walk(child.id, depth + 1);
    }
  };
  await walk(root, 0);

  let filtered = folders;
  if (options.filter !== undefined && options.filter.length > 0) {
    const needle = options.filter.toLowerCase();
    filtered = folders.filter(
      (f) => f.name.toLowerCase().includes(needle) || f.id.toLowerCase().includes(needle),
    );
  }

  return { root, folders: filtered };
}

/**
 * Render an id/name tree of the discovered folders for the human listing. Each
 * line is indented by depth and shows `<id>  <name>` so the operator can read
 * the hierarchy and copy any id. Returns lines (no trailing newline).
 */
export function renderTree(result: FoldersResult): string[] {
  if (result.folders.length === 0) return [`(no subfolders under "${result.root}")`];
  return result.folders.map((f) => `${"  ".repeat(f.depth)}${f.id}  ${f.name}`);
}

/**
 * Render a `[connectors.box]` config block the operator can paste straight into
 * `config.toml`. The `folders` array carries every discovered folder id (a
 * mistyped id silently ingests nothing — the gap this closes, ADR-0030) with a
 * trailing `# <name>` comment for readability.
 */
export function renderConfigBlock(result: FoldersResult): string[] {
  const entries: ConfigBlockEntry[] = result.folders.map((f) => ({
    value: f.id,
    label: f.name || "(no name)",
  }));
  return renderConnectorConfigBlock("box", entries, {
    key: "folders",
    idNote: "folders are Box folder ids — the # comment is just the folder name",
  });
}
