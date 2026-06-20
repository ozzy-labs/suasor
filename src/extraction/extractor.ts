/**
 * Document-extraction abstraction + sidecar client (ADR-0024).
 *
 * Office/PDF files are ingested name-only until a sidecar converts their bodies
 * to text/Markdown. Per the ML delegation invariant (ADR-0006) Suasor never runs
 * heavy parsers in-process — an `Extractor` is a **thin client** over a local
 * markitdown-style sidecar. No docx/xlsx/pptx/pdf parser in `src/`.
 *
 * The client is format-agnostic (it extracts whatever bytes it is given); the
 * sync wiring (ADR-0024 §3, a follow-up PR) decides which entries to send based
 * on extension and the `local`-first scope. Failures raise `ExtractionError` so
 * the caller degrades to name-only (best-effort, ingest still succeeds).
 */
import type { ExtractionConfig } from "../config/schema.ts";

/**
 * File extensions the extraction sidecar handles (ADR-0024 §1). Connectors mark
 * matching entries `extractable`; the maintenance status counts pending ones by
 * the same set. Disjoint from text extensions (those are read directly).
 */
export const EXTRACTABLE_EXTENSIONS = new Set([".docx", ".xlsx", ".pptx", ".pdf"]);

/** A thin extraction client. Delegates to a sidecar — never in-process parsing. */
export interface Extractor {
  /**
   * Optional extractor build/version tag, recorded in the extraction provenance
   * sidecar so an extractor upgrade can be detected as stale (re-extract) even
   * when the backend is unchanged (ADR-0024 §6). Undefined → treated as "".
   */
  readonly version?: string;
  /**
   * Extract text/Markdown from one document's bytes. Returns the extracted text,
   * or `null` when the sidecar reports the format unsupported (caller keeps
   * name-only). Raises {@link ExtractionError} on transport/protocol failure.
   */
  extract(bytes: Uint8Array, filename: string): Promise<string | null>;
}

/** Raised when a sidecar call fails or returns a malformed response. */
export class ExtractionError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "ExtractionError";
  }
}

/** Minimal `fetch` shape used by the client (injectable for tests). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface MarkitdownExtractorOptions {
  /** Sidecar base URL (e.g. `http://localhost:8929`). */
  baseUrl: string;
  /** Extractor version tag recorded in `extraction_meta` for drift detection. */
  version?: string;
  /** Injectable fetch (defaults to global `fetch`). */
  fetchImpl?: FetchLike;
}

/** Shape of a markitdown `/extract` response. `text: null` ⇒ unsupported format. */
interface MarkitdownExtractResponse {
  text?: string | null;
  /** Optional extractor build tag echoed by the sidecar. */
  version?: string;
}

/**
 * Extractor over a markitdown-style sidecar `POST {baseUrl}/extract` (ADR-0024).
 *
 * Sends the raw bytes with the original filename (so the sidecar can dispatch by
 * extension) and expects `{ text }` JSON back (`text: null` ⇒ unsupported). The
 * call is local (no egress) and carries no secrets. A non-2xx response or a
 * malformed body raises `ExtractionError` so the caller degrades to name-only.
 */
export class MarkitdownExtractor implements Extractor {
  readonly version: string;
  private readonly endpoint: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: MarkitdownExtractorOptions) {
    this.version = options.version ?? "";
    // Trim a single trailing slash so `baseUrl` with or without one both work.
    this.endpoint = `${options.baseUrl.replace(/\/$/, "")}/extract`;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async extract(bytes: Uint8Array, filename: string): Promise<string | null> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-filename": encodeURIComponent(filename),
        },
        body: bytes as unknown as RequestInit["body"],
      });
    } catch (cause) {
      throw new ExtractionError(`markitdown extract request failed: ${this.endpoint}`, cause);
    }

    if (!response.ok) {
      throw new ExtractionError(`markitdown extract returned HTTP ${response.status}`);
    }

    let body: MarkitdownExtractResponse;
    try {
      body = (await response.json()) as MarkitdownExtractResponse;
    } catch (cause) {
      throw new ExtractionError("markitdown extract returned a non-JSON body", cause);
    }

    // `text: null`/absent ⇒ the sidecar could not extract (unsupported format).
    if (body.text === null || body.text === undefined) return null;
    if (typeof body.text !== "string") {
      throw new ExtractionError("markitdown extract returned a non-string `text`");
    }
    return body.text;
  }
}

/**
 * Build an `Extractor` from the effective `[extraction]` config, or `null` when
 * no extractor is available (backend `disabled`). A `null` extractor is the
 * graceful-degradation signal: ingest keeps Office/PDF bodies name-only
 * (ADR-0024) and nothing is sent to a sidecar.
 */
export function createExtractor(
  config: Pick<ExtractionConfig, "backend" | "baseUrl"> & { version?: string },
  fetchImpl?: FetchLike,
): Extractor | null {
  if (config.backend === "markitdown") {
    return new MarkitdownExtractor({
      baseUrl: config.baseUrl,
      ...(config.version !== undefined ? { version: config.version } : {}),
      ...(fetchImpl ? { fetchImpl } : {}),
    });
  }
  // disabled (default) → no extractor; Office/PDF stay name-only.
  return null;
}
