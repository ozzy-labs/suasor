/**
 * Box connector (ADR-0007). Read-only ingest of files under the configured Box
 * folders into `SourceRecord`s.
 *
 * - **body** — the record `body` is the file **name**. Office/PDF files
 *   (`.docx`/`.xlsx`/`.pptx`/`.pdf`) additionally carry an `extractable` handle
 *   so the shared sync extraction stage (ADR-0024) can fetch their content via
 *   the Box API and replace the body with sidecar-extracted text. Non-extractable
 *   files stay name-only. Fetch/extraction is best-effort: a download or sidecar
 *   failure degrades back to name-only and ingest still succeeds (ADR-0024 §3).
 * - **read-only** — only Box `GET` folder-item listings and file **downloads**
 *   are called; nothing is written back (ADR-0003).
 * - **delta** — folder items are paged via a marker/offset. The connector walks
 *   every page each run and supplies a content fingerprint when Box reports the
 *   file `sha1` (content hash). The content sha1 (not the filename) drives delta
 *   detection (FR-ING-3), so a file's content changing — even without a rename —
 *   surfaces as a `SourceBodyUpdated` and triggers re-extraction (ADR-0024 §6,
 *   the content-fingerprint prerequisite for API connectors). When `sha1` is
 *   absent the connector omits the fingerprint and the sync service falls back to
 *   SHA-256-over-body (the filename). `finalize` returns `cursor: null`.
 * - **identity** — `box:file:<id>` (cross-source-unique, ADR-0007).
 *   `source_type` is `box_file`.
 * - **import-clean** — `box-typescript-sdk-gen` is **lazy-imported inside `sync`**,
 *   so building the connector / registry never pulls the SDK (ADR-0007,
 *   NFR-PRF-1). Top-level imports are limited to `zod` + the contract + extraction
 *   extension set (a pure `Set`, no SDK).
 * - **secrets** — the developer / OAuth access token comes from
 *   `ctx.secret("token")` (keychain + env override, NFR-PRV-4).
 */
import { extname } from "node:path";
import { z } from "zod";
import { EXTRACTABLE_EXTENSIONS } from "../extraction/index.ts";
import type {
  Connector,
  ConnectorConfig,
  SourceRecord,
  SyncContext,
  SyncResult,
} from "./contract.ts";
import { type IsolationResult, syncResourcesIsolated } from "./per-resource.ts";

/** `[connectors.box]` config (docs/design/config.md). */
export const BoxConnectorConfig = z.object({
  /** Folder ids to ingest (Box root is "0"). */
  folders: z.array(z.string().min(1)).default([]),
});
export type BoxConnectorConfig = z.infer<typeof BoxConnectorConfig>;

export const BOX_CONNECTOR_NAME = "box";

/** A normalized Box file item the connector maps into a record. */
export interface BoxFileItem {
  id: string;
  name: string;
  /** Extracted description / representation text held locally. */
  description?: string;
  modifiedAt?: string;
  /** File size in bytes (drives the extraction size guard, ADR-0024 §5). */
  size?: number;
  /**
   * Box content SHA-1 (the file's content hash). Used as the delta fingerprint so
   * a content change is detected even without a rename (ADR-0024 §6). Absent ⇒
   * the connector omits the fingerprint (sync falls back to SHA-256-over-body).
   */
  sha1?: string;
}

/** One page of a Box folder listing. */
export interface BoxPage {
  files: BoxFileItem[];
  /** Pagination marker for the next page, if any. */
  nextMarker?: string;
}

/**
 * Build a `SourceRecord` for one Box file.
 *
 * The `body` is the filename (name-only). Office/PDF files additionally carry an
 * `extractable` handle whose `readBytes` lazily downloads the file content via
 * the Box API; the shared sync extraction stage (ADR-0024) replaces the body with
 * the sidecar's extracted text for new/changed records. `readBytes` is only
 * called when extraction actually runs, so non-extractable files and unchanged
 * records pay no download cost.
 *
 * The `fingerprint` is the Box content `sha1` when available, so a content-only
 * change (same filename) surfaces as `SourceBodyUpdated` and re-extracts (the
 * content-fingerprint prerequisite for API connectors, ADR-0024 §6). When Box
 * does not report `sha1` the fingerprint is omitted and the sync service falls
 * back to SHA-256-over-body (the filename).
 */
function toRecord(item: BoxFileItem, client: BoxClientLike): SourceRecord {
  const body = item.name && item.description ? `${item.name}\n\n${item.description}` : item.name;
  const ext = extname(item.name).toLowerCase();
  // Office/PDF binaries are offered to the extraction sidecar via the Box API
  // (ADR-0024). Lazy download: readBytes is called at most once, only for
  // new/changed records when an extractor is configured.
  const extractable =
    EXTRACTABLE_EXTENSIONS.has(ext) && item.size !== undefined
      ? {
          filename: item.name,
          byteSize: item.size,
          readBytes: (): Promise<Uint8Array> => client.downloadFile(item.id),
        }
      : undefined;
  return {
    externalId: `box:file:${item.id}`,
    sourceType: "box_file",
    body,
    observedAt: item.modifiedAt ?? new Date(0).toISOString(),
    meta: { id: item.id, name: item.name },
    ...(item.sha1 ? { fingerprint: item.sha1 } : {}),
    ...(extractable !== undefined ? { extractable } : {}),
  };
}

/**
 * The Box client surface we depend on: list one page of files in a folder, and
 * download one file's bytes. Declared structurally (already normalized) so tests
 * inject a fake without the SDK and so the real client is lazy-loaded.
 */
export interface BoxClientLike {
  listFolder(folderId: string, marker?: string): Promise<BoxPage>;
  /** Download one file's raw bytes (read-only; used by the extraction handle). */
  downloadFile(fileId: string): Promise<Uint8Array>;
}

/** How the connector obtains a Box client (overridable in tests). */
export type BoxClientFactory = (token: string) => Promise<BoxClientLike> | BoxClientLike;

/**
 * Default factory: lazy-imports `box-typescript-sdk-gen`, building a developer-
 * token client and normalizing folder items into `BoxFileItem`s (files only).
 * Kept out of the top level so registration stays import-clean (ADR-0007).
 */
const defaultBoxClientFactory: BoxClientFactory = async (token) => {
  const { BoxClient, BoxDeveloperTokenAuth } = await import("box-typescript-sdk-gen");
  const auth = new BoxDeveloperTokenAuth({ token });
  const client = new BoxClient({ auth });
  return {
    async listFolder(folderId, marker) {
      const res = await client.folders.getFolderItems(folderId, {
        queryParams: {
          usemarker: true,
          // `size` + `sha1` drive the extraction size guard and content
          // fingerprint (ADR-0024 §5/§6) on top of the name-only ingest.
          fields: ["id", "name", "modified_at", "type", "size", "sha1"],
          ...(marker ? { marker } : {}),
        },
      });
      const entries = (res.entries ?? []) as Array<{
        type?: string;
        id?: string;
        name?: string;
        modified_at?: string;
        size?: number;
        sha1?: string;
      }>;
      const files: BoxFileItem[] = entries
        .filter((e) => e.type === "file")
        .map((e) => ({
          id: e.id ?? "",
          name: e.name ?? "",
          modifiedAt: e.modified_at,
          ...(typeof e.size === "number" ? { size: e.size } : {}),
          ...(e.sha1 ? { sha1: e.sha1 } : {}),
        }));
      return { files, nextMarker: res.nextMarker ?? undefined };
    },
    async downloadFile(fileId) {
      // Read-only content fetch for extraction (ADR-0024). Box returns a Node
      // `Readable` (its `ByteStream`); drain it via the standard async iterator
      // (Buffer chunks) and concatenate — no dependency on an SDK-internal
      // helper. `undefined` (no content) degrades to an empty buffer so the
      // caller falls back to name-only.
      const stream = (await client.downloads.downloadFile(fileId)) as
        | AsyncIterable<Uint8Array>
        | undefined;
      if (!stream) return new Uint8Array(0);
      const chunks: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of stream) {
        const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        chunks.push(bytes);
        total += bytes.byteLength;
      }
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return out;
    },
  };
};

export interface BoxConnectorOptions {
  /** Box client factory override (tests inject a fake; default lazy-imports the SDK). */
  clientFactory?: BoxClientFactory;
}

/** Box connector implementing the read-only contract (ADR-0007). */
class BoxConnector implements Connector {
  readonly name = BOX_CONNECTOR_NAME;
  readonly sourceType = "box";

  /** Per-folder isolation outcome (set when `sync` ran) → finalize summary. */
  private isolation: IsolationResult | null = null;

  constructor(
    private readonly config: BoxConnectorConfig,
    private readonly clientFactory: BoxClientFactory,
  ) {}

  async *sync(ctx: SyncContext): AsyncIterable<SourceRecord> {
    if (this.config.folders.length === 0) return;

    const token = await ctx.secret("token");
    if (!token) {
      throw new Error(
        "box connector: no token configured " +
          "(set SUASOR_CONNECTOR_BOX_TOKEN or store it in the OS keychain)",
      );
    }

    const client = await this.clientFactory(token);
    this.isolation = null;

    // Per-folder error isolation (ADR-0014 generalized, Issue #193): one folder
    // failing (e.g. a 403 / not-found) records a warn and is skipped while the
    // rest stream; only an all-folders failure throws.
    const fetchFolder = (folder: string): AsyncIterable<SourceRecord> =>
      (async function* () {
        let marker: string | undefined;
        do {
          const page = await client.listFolder(folder, marker);
          for (const item of page.files) {
            yield toRecord(item, client);
          }
          marker = page.nextMarker;
        } while (marker);
      })();

    yield* syncResourcesIsolated(
      this.config.folders,
      ctx,
      (folder) => folder,
      "folder",
      fetchFolder,
      (result) => {
        this.isolation = result;
      },
    );
  }

  finalize(): SyncResult {
    // Fingerprint-based change detection; no per-run cursor to persist. A
    // partial folder failure is surfaced so the CLI exits non-zero without
    // discarding the collected records (ADR-0027, Issue #193).
    const iso = this.isolation;
    if (iso?.partialFailure) {
      return {
        cursor: null,
        partialFailure: true,
        ...(iso.summaryLines ? { summaryLines: iso.summaryLines } : {}),
      };
    }
    return { cursor: null };
  }
}

/**
 * Build the Box connector from its config slice (validates with Zod).
 * `box-typescript-sdk-gen` is not imported here — only when `sync` actually runs.
 */
export function createBoxConnector(
  config: ConnectorConfig,
  options: BoxConnectorOptions = {},
): Connector {
  const parsed = BoxConnectorConfig.parse(config ?? {});
  return new BoxConnector(parsed, options.clientFactory ?? defaultBoxClientFactory);
}
