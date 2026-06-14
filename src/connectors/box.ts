/**
 * Box connector (ADR-0007). Read-only ingest of files under the configured Box
 * folders into `SourceRecord`s.
 *
 * - **read-only** — only Box `GET` folder-item listings are called; nothing is
 *   written back (ADR-0003).
 * - **delta** — folder items are paged via a marker/offset. The connector walks
 *   every page each run and relies on the body fingerprint (sync service SHA-256,
 *   here seeded from the file's content hash when available) for change detection
 *   (FR-ING-3); `finalize` returns `cursor: null`.
 * - **identity** — `box:file:<id>` (cross-source-unique, ADR-0007).
 *   `source_type` is `box_file`.
 * - **import-clean** — `box-typescript-sdk-gen` is **lazy-imported inside `sync`**,
 *   so building the connector / registry never pulls the SDK (ADR-0007,
 *   NFR-PRF-1). Top-level imports are limited to `zod` + the contract types.
 * - **secrets** — the developer / OAuth access token comes from
 *   `ctx.secret("token")` (keychain + env override, NFR-PRV-4).
 */
import { z } from "zod";
import type {
  Connector,
  ConnectorConfig,
  SourceRecord,
  SyncContext,
  SyncResult,
} from "./contract.ts";

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
  /** Box content SHA-1; used as the change-detection fingerprint when present. */
  sha1?: string;
}

/** One page of a Box folder listing. */
export interface BoxPage {
  files: BoxFileItem[];
  /** Pagination marker for the next page, if any. */
  nextMarker?: string;
}

/** Build a `SourceRecord` for one Box file. */
function toRecord(item: BoxFileItem): SourceRecord {
  const body =
    item.name && item.description ? `${item.name}\n\n${item.description}` : item.name;
  return {
    externalId: `box:file:${item.id}`,
    sourceType: "box_file",
    body,
    observedAt: item.modifiedAt ?? new Date(0).toISOString(),
    meta: { id: item.id, name: item.name },
    // Prefer Box's content hash so a metadata-only listing still detects body
    // changes; the sync service falls back to a body SHA-256 when omitted.
    ...(item.sha1 ? { fingerprint: item.sha1 } : {}),
  };
}

/**
 * The Box client surface we depend on: list one page of files in a folder.
 * Declared structurally (already normalized to `BoxFileItem`) so tests inject a
 * fake without the SDK and so the real client is lazy-loaded.
 */
export interface BoxClientLike {
  listFolder(folderId: string, marker?: string): Promise<BoxPage>;
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
          fields: ["id", "name", "modified_at", "sha1", "type"],
          ...(marker ? { marker } : {}),
        },
      });
      const entries = (res.entries ?? []) as Array<{
        type?: string;
        id?: string;
        name?: string;
        modified_at?: string;
        sha1?: string;
      }>;
      const files: BoxFileItem[] = entries
        .filter((e) => e.type === "file")
        .map((e) => ({
          id: e.id ?? "",
          name: e.name ?? "",
          modifiedAt: e.modified_at,
          sha1: e.sha1,
        }));
      return { files, nextMarker: res.nextMarker ?? undefined };
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

    for (const folder of this.config.folders) {
      let marker: string | undefined;
      do {
        const page = await client.listFolder(folder, marker);
        for (const item of page.files) {
          yield toRecord(item);
        }
        marker = page.nextMarker;
      } while (marker);
    }
  }

  finalize(): SyncResult {
    // Fingerprint-based change detection; no per-run cursor to persist.
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
