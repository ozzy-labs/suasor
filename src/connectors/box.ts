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
 * - **identity** — `box:file:<id>` (cross-source-unique, ADR-0007), or
 *   `box:<account>:file:<id>` for a named account (ADR-0050). `source_type` is
 *   `box_file`.
 * - **multi-account** — `[connectors.box.accounts.<account>]` ingests more than
 *   one Box account (personal + work) in one pass (ADR-0050), each with its own
 *   `token` (`connector:box:<account>:token`), its own `folders`, and per-account
 *   error isolation. A config with no `accounts` table is exactly one unprefixed
 *   `default` account. The account has to be *named* because a Box folder id is
 *   account-relative — the root folder of **every** Box account is id `0`
 *   (developer.box.com), so `folders = ["0"]` cannot say whose root it means.
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
  CredentialRequirement,
  SourceRecord,
  SyncContext,
  SyncResult,
} from "./contract.ts";
import type { ConnectorManifest } from "./manifest.ts";
import {
  type AccountIsolationResult,
  type AccountSlice,
  accountIdPrefix,
  accountSecretName,
  accountSlices,
  accountsRecord,
  syncAccountsIsolated,
} from "./multi-account.ts";
import { syncResourcesIsolated } from "./per-resource.ts";

/**
 * Settings for **one** Box account. `folders` is per-account by necessity, not by
 * convention: a Box folder id is account-relative (the root of every account is
 * id `0`), so the same array means different folders under a different token.
 */
const BoxAccountSettings = z.object({
  /** Folder ids to ingest (Box root is "0"). */
  folders: z.array(z.string().min(1)).default([]),
});
export type BoxAccountSettings = z.infer<typeof BoxAccountSettings>;

/**
 * `[connectors.box]` config (docs/design/config.md). The flat keys configure the
 * single `default` account **and** act as inherited defaults for every entry of
 * the optional `[connectors.box.accounts.<account>]` table (ADR-0050).
 */
export const BoxConnectorConfig = BoxAccountSettings.extend({
  accounts: accountsRecord(BoxAccountSettings.partial().strict()),
});
export type BoxConnectorConfig = z.infer<typeof BoxConnectorConfig>;

export const BOX_CONNECTOR_NAME = "box";

/** Credential precondition enforced centrally by the sync service (Issue #440). */
const BOX_CREDENTIALS: CredentialRequirement = {
  secretNames: ["token"],
  missingMessage:
    "box connector: no token configured " +
    "(set SUASOR_CONNECTOR_BOX_TOKEN or store it in the OS keychain)",
};

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
function toRecord(item: BoxFileItem, client: BoxClientLike, account: AccountSlice): SourceRecord {
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
    // Named accounts namespace the id (ADR-0050 決定 3). Box does not document a
    // uniqueness scope for file ids, and a *collaborated* file is literally the
    // same object — same id — in every account it is shared into, so a personal
    // and a work account that share a folder would otherwise write one source
    // row twice per pass and attribute it to whichever ran first. `default`
    // stays unprefixed so an existing install's lineage holds.
    externalId: `box:${accountIdPrefix(account)}file:${item.id}`,
    sourceType: "box_file",
    body,
    observedAt: item.modifiedAt ?? new Date(0).toISOString(),
    meta: {
      id: item.id,
      name: item.name,
      // Only for an explicitly declared account, so single-account records keep
      // exactly the meta they had.
      ...(account.declared ? { account: account.name } : {}),
    },
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

/** One resolved Box account: its raw slice plus its parsed settings. */
interface BoxAccount extends AccountSlice {
  readonly settings: BoxAccountSettings;
}

/**
 * Build the credential precondition for the configured accounts (ADR-0007
 * any-of): the pass throws only when **no** account has a token, while an
 * individual tokenless account is left to the per-account skip below.
 */
function boxCredentials(accounts: readonly BoxAccount[]): CredentialRequirement {
  const secretNames = accounts.map((account) => accountSecretName(account, "token"));
  const single = accounts.length === 1 && !(accounts[0] as BoxAccount).declared;
  return {
    secretNames,
    missingMessage: single
      ? BOX_CREDENTIALS.missingMessage
      : `box connector: no token configured for any account ` +
        `(${accounts.map((a) => `'${a.name}'`).join(", ")}) — store each account's token under ` +
        `keychain account 'connector:box:<account>:token', or set ` +
        `SUASOR_CONNECTOR_BOX_<ACCOUNT>_TOKEN`,
  };
}

/** Box connector implementing the read-only contract (ADR-0007). */
class BoxConnector implements Connector {
  readonly name = BOX_CONNECTOR_NAME;
  readonly sourceType = "box";
  readonly credentials: CredentialRequirement;

  /** Per-account isolation outcome (set when `sync` ran) → finalize summary. */
  private accountIsolation: AccountIsolationResult | null = null;
  /** Per-account folder-isolation summary lines, in run order. */
  private folderSummaries: string[] = [];
  /** Whether any account saw a partial per-folder failure. */
  private folderPartial = false;

  constructor(
    private readonly accounts: readonly BoxAccount[],
    private readonly clientFactory: BoxClientFactory,
  ) {
    this.credentials = boxCredentials(accounts);
  }

  async *sync(ctx: SyncContext): AsyncIterable<SourceRecord> {
    // Empty scope is a genuine no-op: the credential precondition (`credentials`
    // above) is enforced centrally by the sync service before `sync()` runs, so
    // this early return can never mask a missing token (ADR-0007 "credential 解決
    // は scope-emptiness 判定に先行する", Issue #440). Per account (ADR-0050): an
    // account with no folders is dropped from the pass.
    const active = this.accounts.filter((account) => account.settings.folders.length > 0);
    if (active.length === 0) return;

    this.accountIsolation = null;
    this.folderSummaries = [];
    this.folderPartial = false;
    const tokens = new Map<string, string>();

    yield* syncAccountsIsolated(
      active,
      ctx,
      async (account) => {
        const token = await ctx.secret(accountSecretName(account, "token"));
        // A tokenless account is skipped with a warning, never a total failure
        // (ADR-0007 multi-account clause).
        if (token === null) return "no token configured";
        tokens.set(account.name, token);
        return null;
      },
      (account, accountCtx) =>
        this.syncAccount(account, tokens.get(account.name) as string, accountCtx),
      (result) => {
        this.accountIsolation = result;
      },
    );
  }

  /** Stream one account's configured folders, with per-folder isolation. */
  private async *syncAccount(
    account: BoxAccount,
    token: string,
    ctx: SyncContext,
  ): AsyncIterable<SourceRecord> {
    const client = await this.clientFactory(token);

    // Per-folder error isolation (ADR-0014 generalized, Issue #193): one folder
    // failing (e.g. a 403 / not-found) records a warn and is skipped while the
    // rest stream; only an all-folders failure throws — which the account layer
    // above then isolates to this account (ADR-0050).
    const fetchFolder = (folder: string): AsyncIterable<SourceRecord> =>
      (async function* () {
        let marker: string | undefined;
        do {
          const page = await client.listFolder(folder, marker);
          for (const item of page.files) {
            yield toRecord(item, client, account);
          }
          marker = page.nextMarker;
        } while (marker);
      })();

    yield* syncResourcesIsolated(
      account.settings.folders,
      ctx,
      (folder) => folder,
      "folder",
      fetchFolder,
      (result) => {
        if (result.partialFailure) this.folderPartial = true;
        for (const line of result.summaryLines ?? []) {
          this.folderSummaries.push(account.declared ? `account '${account.name}' ${line}` : line);
        }
      },
    );
  }

  finalize(): SyncResult {
    // Fingerprint-based change detection; no per-run cursor to persist. A
    // partial failure — at either layer, a degraded account or a failed folder —
    // is surfaced so the CLI exits non-zero without discarding the collected
    // records (ADR-0027, Issue #193 / ADR-0050).
    const partial = (this.accountIsolation?.partialFailure ?? false) || this.folderPartial;
    if (!partial) return { cursor: null };
    const summaryLines = [...(this.accountIsolation?.summaryLines ?? []), ...this.folderSummaries];
    return {
      cursor: null,
      partialFailure: true,
      ...(summaryLines.length > 0 ? { summaryLines } : {}),
    };
  }
}

/**
 * Build the Box connector from its config slice (validates with Zod).
 * `box-typescript-sdk-gen` is not imported here — only when `sync` actually runs.
 *
 * The slice is resolved into one account per `[connectors.box.accounts.<x>]`
 * entry — or the single implicit `default` account when there is no table
 * (ADR-0050) — each inheriting the flat keys it does not override.
 */
export function createBoxConnector(
  config: ConnectorConfig,
  options: BoxConnectorOptions = {},
): Connector {
  // Validate the whole slice first (account names, env-override collisions,
  // per-account typos) so those errors surface here and not as a confusing
  // failure inside one account's settings. The result is deliberately
  // discarded: Zod fills schema defaults into every account, which erases the
  // absent-vs-set distinction inheritance needs, so the effective config comes
  // from the raw merge in `accountSlices` (see multi-account.ts).
  BoxConnectorConfig.parse(config ?? {});
  const accounts: BoxAccount[] = accountSlices(config ?? {}).map((account) => ({
    ...account,
    settings: BoxAccountSettings.parse(account.slice),
  }));
  return new BoxConnector(accounts, options.clientFactory ?? defaultBoxClientFactory);
}

/** Platform manifest (SSOT for the scattered per-connector tables, Issue #440). */
export const manifest: ConnectorManifest = {
  name: BOX_CONNECTOR_NAME,
  sourceType: "box",
  configSchema: BoxConnectorConfig,
  secretNames: BOX_CREDENTIALS.secretNames,
  needsAuth: true,
  bundledInBinary: false,
  sliceTemplate: {
    body: [
      "enabled = true",
      '# folders = ["0"]          # Box folder ids to ingest (root は "0")',
      "# A second Box account (personal + work) goes in its own table:",
      "#   [connectors.box.accounts.work]      # see docs/guide/connectors.md (ADR-0050)",
      "#   `suasor onboard --connector box --account work` writes it for you",
    ],
  },
  noopWarning(slice) {
    const cfg = BoxConnectorConfig.parse(slice ?? {});
    if (cfg.folders.length === 0) {
      return "folders unset — nothing to ingest (set folders in config)";
    }
    return null;
  },
  genericAuth: true,
  genericDiscovery: true,
  surfacesChannels: false,
  surfacesTeams: false,
  // Personal + work Box in one install (ADR-0050, #537 — the follow-up #441
  // deferred). The account has to be named because the ingest scope is written
  // in account-relative ids: the root folder of every Box account is `0`, so a
  // flat `folders` list cannot say whose folders it means.
  multiAccount: true,
};
