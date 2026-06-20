/**
 * Document composition (md → Office) — sidecar client (#138).
 *
 * The reverse of the extraction sidecar (ADR-0024, Office → md): converts a
 * draft's Markdown into a binary Office file (docx/pptx/xlsx). Per the ML
 * delegation invariant (ADR-0006) the heavy converter (pandoc-style) runs in a
 * **sidecar**, not in-process — a `Composer` is a thin client. `md`/`txt` exports
 * never use it (`draft.export` writes those directly).
 */
import type { ExportConfig } from "../config/schema.ts";

/** Office formats produced by the composition sidecar (not md/txt). */
export type OfficeFormat = "docx" | "pptx" | "xlsx";

/** A thin composition client. Delegates to a sidecar — never in-process. */
export interface Composer {
  /** Convert Markdown `content` to the binary `format`, returning the bytes. */
  compose(content: string, format: OfficeFormat): Promise<Uint8Array>;
}

/** Raised when a sidecar call fails or returns a malformed response. */
export class ComposeError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "ComposeError";
  }
}

/** Minimal `fetch` shape used by the client (injectable for tests). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface PandocComposerOptions {
  /** Sidecar base URL (e.g. `http://localhost:8930`). */
  baseUrl: string;
  /** Injectable fetch (defaults to global `fetch`). */
  fetchImpl?: FetchLike;
}

/**
 * Composer over a pandoc-style sidecar `POST {baseUrl}/compose` (#138).
 *
 * Sends `{ content, format }` JSON and expects the converted file bytes back
 * (binary body). Local (no egress), no secrets. A non-2xx response raises
 * `ComposeError` so `draft.export` surfaces a tool error (no partial file).
 */
export class PandocComposer implements Composer {
  private readonly endpoint: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: PandocComposerOptions) {
    this.endpoint = `${options.baseUrl.replace(/\/$/, "")}/compose`;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async compose(content: string, format: OfficeFormat): Promise<Uint8Array> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content, format }),
      });
    } catch (cause) {
      throw new ComposeError(`pandoc compose request failed: ${this.endpoint}`, cause);
    }
    if (!response.ok) {
      throw new ComposeError(`pandoc compose returned HTTP ${response.status} for ${format}`);
    }
    try {
      return new Uint8Array(await response.arrayBuffer());
    } catch (cause) {
      throw new ComposeError("pandoc compose returned an unreadable body", cause);
    }
  }
}

/**
 * Build a `Composer` from `[export].composition`, or `null` when disabled. A
 * `null` composer means Office formats are unavailable — `draft.export` then
 * errors on a binary format (md/txt still work without a sidecar).
 */
export function createComposer(
  config: ExportConfig["composition"],
  fetchImpl?: FetchLike,
): Composer | null {
  if (config.backend === "pandoc") {
    return new PandocComposer({
      baseUrl: config.baseUrl,
      ...(fetchImpl ? { fetchImpl } : {}),
    });
  }
  return null;
}
