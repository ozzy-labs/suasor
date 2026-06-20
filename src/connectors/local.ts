/**
 * Local-filesystem connector (ADR-0007 / ADR-0023). Read-only ingest of files
 * under configured local directories (e.g. an OS-synced Box Drive / OneDrive /
 * Dropbox mount, or any plain folder) into `SourceRecord`s.
 *
 * This is the **generic `local` connector** decided in ADR-0023: rather than
 * vendor-specific `box-drive` / `onedrive-drive` connectors, one connector
 * covers N vendors + arbitrary folders by configuration (paths) alone. It is the
 * "local origin" sibling of `web` (which wraps a Playwright snapshot): both
 * ingest a locally-observed source that has no upstream delta API.
 *
 * - **read-only** — only directory listings + file reads are performed; nothing
 *   is written back to the filesystem (ADR-0003).
 * - **delta** — there is no upstream delta API, so change detection is purely
 *   fingerprint-based (FR-ING-3, ADR-0023): the connector supplies a fingerprint
 *   over `mtime:size:contentHash` so the sync service skips unchanged files
 *   without re-hashing identical content, and surfaces edits as updates.
 *   `finalize` returns `cursor: null` (fingerprint-based, no resume cursor).
 * - **identity** — `local:<sha1(absolutePath)>` (cross-source-unique, stable per
 *   path, ADR-0007/0023 §3: identity keyed by the file's real path, not the
 *   acquisition route, so the API connector (`box`) and this FS connector stay
 *   distinct sources rather than re-ingesting one file twice). `source_type` is
 *   `local_file`.
 * - **import-clean** — only `node:fs/promises`, `node:path`, `node:crypto`, `zod`
 *   and the contract types are imported; there is no heavy SDK to lazy-load.
 * - **secrets** — none required (local filesystem; no auth path), like `web`.
 *
 * **API-connector overlap (ADR-0023 §3)**: the same file can be ingested by both
 * `box` (API) and `local` (FS). Avoiding double-ingest is an operational
 * concern — configure each connector's scope so a given file is owned by exactly
 * one route. Identity is path-based here and `box:file:<id>` there, so they never
 * collapse into one source automatically.
 */
import { createHash } from "node:crypto";
import { accessSync, type Dirent, constants as fsConstants, statSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { z } from "zod";
import { EXTRACTABLE_EXTENSIONS } from "../extraction/index.ts";
import type {
  Connector,
  ConnectorConfig,
  SourceRecord,
  SyncContext,
  SyncResult,
} from "./contract.ts";

/** Default file extensions treated as text bodies (lower-case, with dot). */
const DEFAULT_TEXT_EXTENSIONS = [
  ".txt",
  ".md",
  ".markdown",
  ".rst",
  ".csv",
  ".tsv",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".log",
  ".text",
] as const;

/** `[connectors.local]` config (docs/design/config.md). */
export const LocalConnectorConfig = z.object({
  /** Directories to walk recursively (absolute or relative to cwd). */
  roots: z.array(z.string().min(1)).default([]),
  /**
   * File extensions whose contents are read into the body (lower-case, with a
   * leading dot). Files outside this set are ingested **name-only** (their
   * content is not read), mirroring the `box` filename-only behaviour.
   */
  textExtensions: z.array(z.string().min(1)).default([...DEFAULT_TEXT_EXTENSIONS]),
  /** Maximum bytes of file content read into a body (larger files are name-only). */
  maxBytes: z.number().int().positive().default(1_000_000),
});
export type LocalConnectorConfig = z.infer<typeof LocalConnectorConfig>;

/**
 * Classify why a configured root is unusable at load time, or `null` when it is
 * an existing, readable directory. Uses **sync** `node:fs` so it composes with
 * the config loader's synchronous `safeParse` slice validation (Issue #162 wiring
 * in `validateConnectorSlices`). Mirrors the runtime walker guard
 * (`defaultLocalWalkerFactory.walk`) but fails fast at config-load instead of
 * silently warn+skip at sync time, so a typo'd path (`/Users/me/OnDrive`) surfaces
 * immediately (Issue #188, ADR-0007 "no silent wrong answer").
 *
 * Symlinks are intentionally not special-cased here: the existing connector
 * policy is to not follow symlinks during the walk, and `statSync` follows the
 * link to validate the *target* is a readable directory — consistent with the
 * load-time question "is this a usable root", separate from the walk-time
 * "do not traverse symlinks" rule.
 */
export function classifyRootIssue(root: string): string | null {
  const abs = resolve(root);
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(abs);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return `root does not exist or is unreadable: ${abs} (${reason})`;
  }
  if (!st.isDirectory()) {
    return `root is not a directory: ${abs}`;
  }
  try {
    accessSync(abs, fsConstants.R_OK);
  } catch {
    return `root is not readable: ${abs}`;
  }
  return null;
}

/**
 * Load-time variant of {@link LocalConnectorConfig} that additionally verifies
 * each configured `roots` entry exists and is a readable directory, attaching a
 * field-pointed issue per offending path. Registered as the connector's config
 * slice schema (`registry.CONFIG_SCHEMAS`), so `loadConfig` rejects a bad root as
 * `ConfigError` at startup instead of warn+skipping mid-sync (Issue #188).
 *
 * Kept separate from {@link LocalConnectorConfig} (the structural schema
 * `createLocalConnector` parses) so connector construction and unit tests can use
 * synthetic / injected paths without hitting the real filesystem — the
 * filesystem precondition is a config-load concern, not a build-time one (parity
 * with Slack's `validateSlackSince` living outside the structural schema).
 */
export const LocalConnectorConfigSchema = LocalConnectorConfig.superRefine((value, ctx) => {
  value.roots.forEach((root, index) => {
    const issue = classifyRootIssue(root);
    if (issue !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue, path: ["roots", index] });
    }
  });
});

export const LOCAL_CONNECTOR_NAME = "local";

/** A normalized local file entry the connector maps into a record. */
export interface LocalFileEntry {
  /** Absolute path (identity + meta). */
  path: string;
  /** Base name (always part of the body for discoverability). */
  name: string;
  /** Modification time (epoch milliseconds). */
  mtimeMs: number;
  /** File size in bytes. */
  size: number;
  /** Extracted text content, or `undefined` for name-only ingest. */
  content?: string;
}

/** Stable per-path id component (SHA-1 of the absolute path, hex). */
function pathId(path: string): string {
  return createHash("sha1").update(path).digest("hex");
}

/** Hex SHA-256 of a string (content fingerprint component). */
function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Build a `SourceRecord` for one local file.
 *
 * The `body` is the file name plus its text content (name-only when the content
 * was not read), so files are discoverable by name even when their body is not
 * indexed (parity with `box`). The `fingerprint` is keyed on
 * `mtime:size:contentHash` so a content edit OR a metadata change surfaces as an
 * update, while an unchanged file is skipped by the sync service (FR-ING-3).
 */
function toRecord(entry: LocalFileEntry): SourceRecord {
  const body =
    entry.content !== undefined && entry.content.length > 0
      ? `${entry.name}\n\n${entry.content}`
      : entry.name;
  const contentHash = entry.content !== undefined ? sha256Hex(entry.content) : "";
  // Office/PDF binaries (not read as text) are offered to the extraction sidecar
  // (ADR-0024). Lazy: the sync service calls readBytes only for new/changed
  // records when an extractor is configured. fingerprint stays mtime:size-based
  // (the file entity), so extraction never affects delta detection.
  const ext = extname(entry.name).toLowerCase();
  const extractable = EXTRACTABLE_EXTENSIONS.has(ext)
    ? {
        filename: entry.name,
        byteSize: entry.size,
        readBytes: async (): Promise<Uint8Array> => readFile(entry.path),
      }
    : undefined;
  return {
    externalId: `local:${pathId(entry.path)}`,
    sourceType: "local_file",
    body,
    observedAt: new Date(entry.mtimeMs).toISOString(),
    fingerprint: sha256Hex(`${entry.mtimeMs}:${entry.size}:${contentHash}`),
    meta: { path: entry.path, name: entry.name, size: entry.size },
    ...(extractable !== undefined ? { extractable } : {}),
  };
}

/**
 * The filesystem surface the connector depends on: walk a root directory and
 * yield normalized file entries. Declared structurally so tests inject a fake
 * without touching a real disk and so the connector itself stays thin.
 */
export interface LocalWalkerLike {
  /** Walk one root, yielding every readable file entry beneath it. */
  walk(root: string): AsyncIterable<LocalFileEntry>;
}

/** How the connector obtains a walker (overridable in tests). */
export type LocalWalkerFactory = (options: {
  textExtensions: readonly string[];
  maxBytes: number;
  onWarn?: (message: string) => void;
}) => LocalWalkerLike;

/**
 * Default walker: recurses a root with `node:fs/promises`, reading text-extension
 * files up to `maxBytes` and emitting the rest name-only. Symlinks are not
 * followed (read-only, avoids cycles). Unreadable entries are warned and skipped
 * rather than aborting the whole pass.
 */
const defaultLocalWalkerFactory: LocalWalkerFactory = ({ textExtensions, maxBytes, onWarn }) => {
  const textExt = new Set(textExtensions.map((e) => e.toLowerCase()));

  async function* walkDir(dir: string): AsyncIterable<LocalFileEntry> {
    let dirents: Dirent[];
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch (cause) {
      onWarn?.(`cannot read directory ${dir}: ${cause instanceof Error ? cause.message : cause}`);
      return;
    }
    for (const dirent of dirents) {
      const full = join(dir, dirent.name);
      // Skip symlinks entirely (do not follow) to stay read-only + cycle-free.
      if (dirent.isSymbolicLink()) continue;
      if (dirent.isDirectory()) {
        yield* walkDir(full);
        continue;
      }
      if (!dirent.isFile()) continue;
      try {
        const st = await stat(full);
        const ext = extname(dirent.name).toLowerCase();
        let content: string | undefined;
        if (textExt.has(ext) && st.size <= maxBytes) {
          content = await readFile(full, "utf8");
        }
        yield {
          path: full,
          name: dirent.name,
          mtimeMs: st.mtimeMs,
          size: st.size,
          ...(content !== undefined ? { content } : {}),
        };
      } catch (cause) {
        onWarn?.(`cannot read file ${full}: ${cause instanceof Error ? cause.message : cause}`);
      }
    }
  }

  return {
    async *walk(root) {
      const abs = resolve(root);
      // Guard against the root itself being unreadable / not a directory.
      try {
        const st = await stat(abs);
        if (!st.isDirectory()) {
          onWarn?.(`root is not a directory, skipping: ${abs}`);
          return;
        }
      } catch (cause) {
        onWarn?.(`cannot stat root ${abs}: ${cause instanceof Error ? cause.message : cause}`);
        return;
      }
      yield* walkDir(abs);
    },
  };
};

export interface LocalConnectorOptions {
  /** Walker factory override (tests inject a fake; default walks the real FS). */
  walkerFactory?: LocalWalkerFactory;
}

/** Local-filesystem connector implementing the read-only contract (ADR-0007). */
class LocalConnector implements Connector {
  readonly name = LOCAL_CONNECTOR_NAME;
  readonly sourceType = "local";

  constructor(
    private readonly config: LocalConnectorConfig,
    private readonly walkerFactory: LocalWalkerFactory,
  ) {}

  async *sync(ctx: SyncContext): AsyncIterable<SourceRecord> {
    if (this.config.roots.length === 0) return;

    const walker = this.walkerFactory({
      textExtensions: this.config.textExtensions,
      maxBytes: this.config.maxBytes,
      ...(ctx.onWarn ? { onWarn: ctx.onWarn } : {}),
    });

    // De-dup identical absolute paths reached via overlapping roots so a file
    // shared by two configured roots is ingested once per pass.
    const seen = new Set<string>();
    for (const root of this.config.roots) {
      for await (const entry of walker.walk(root)) {
        // Normalize trailing separators in identity-relevant paths.
        const key = entry.path.endsWith(sep) ? entry.path.slice(0, -1) : entry.path;
        if (seen.has(key)) continue;
        seen.add(key);
        yield toRecord({ ...entry, path: key });
      }
    }
  }

  finalize(): SyncResult {
    // Fingerprint-based change detection; no per-run cursor to persist.
    return { cursor: null };
  }
}

/**
 * Build the Local connector from its config slice (validates with Zod).
 * No SDK is involved; the walker uses `node:fs/promises` directly.
 */
export function createLocalConnector(
  config: ConnectorConfig,
  options: LocalConnectorOptions = {},
): Connector {
  const parsed = LocalConnectorConfig.parse(config ?? {});
  return new LocalConnector(parsed, options.walkerFactory ?? defaultLocalWalkerFactory);
}
