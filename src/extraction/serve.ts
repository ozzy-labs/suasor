/**
 * Reference extraction sidecar — the shipped implementation of the extraction
 * contract (`POST {baseUrl}/extract`, ADR-0024) that `suasor extraction serve`
 * exposes over HTTP.
 *
 * Rather than asking every install to author its own HTTP wrapper (retrieval-4),
 * this is a thin shim that spawns the [markitdown](https://github.com/microsoft/markitdown)
 * CLI **once per request** to convert one document's bytes to Markdown. All ML
 * stays in the markitdown subprocess — Suasor runs no in-process parser and holds
 * no model, consistent with the ML-delegation invariant's binary-sidecar
 * allowance (ADR-0006). The request bytes are written to a temp file named with
 * the source extension so markitdown dispatches by format, then removed.
 *
 * Failure mapping (so the thin client in `extractor.ts` degrades correctly):
 *   - extension outside EXTRACTABLE_EXTENSIONS → `200 { text: null }` (unsupported → name-only)
 *   - markitdown exits non-zero                → `500` (transport failure → retry next sync)
 *   - markitdown missing (ENOENT)              → `503` structured install guidance
 *   - markitdown exits 0                        → `200 { text }` (extracted body)
 */
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { EXTRACTABLE_EXTENSIONS } from "./extractor.ts";

/** Default markitdown executable spawned per request (overridable via `--command`). */
export const DEFAULT_MARKITDOWN_COMMAND = "markitdown";

/**
 * Structured guidance surfaced when the markitdown CLI is absent — both at
 * `serve` startup (fail fast) and in the per-request `503` body. Local install
 * only; markitdown runs offline (no egress, no secrets).
 */
export const MARKITDOWN_INSTALL_HINT = {
  code: "markitdown_not_installed",
  message: "the markitdown CLI is not installed or not on PATH",
  install: [
    "uv tool install 'markitdown[all]'",
    "pipx install 'markitdown[all]'",
    "pip install 'markitdown[all]'",
  ],
  docs: "https://github.com/microsoft/markitdown",
} as const;

/** One markitdown invocation result. `notFound` ⇒ the binary is missing (ENOENT). */
export interface MarkitdownRunResult {
  code: number;
  stdout: string;
  stderr: string;
  notFound: boolean;
}

/** Runs the markitdown CLI. Injectable so the server is testable without markitdown. */
export type MarkitdownRun = (command: string, args: string[]) => Promise<MarkitdownRunResult>;

/** Dependencies for the extraction shim (all injectable for tests). */
export interface ExtractServeDeps {
  /** markitdown executable (default {@link DEFAULT_MARKITDOWN_COMMAND}). */
  command?: string;
  /** markitdown runner (default {@link defaultMarkitdownRun}). */
  run?: MarkitdownRun;
  /** Temp dir for the per-request spool file (default `os.tmpdir()`). */
  tmpDir?: string;
}

/** Default runner: spawns the markitdown CLI, mapping a missing binary to `notFound`. */
export const defaultMarkitdownRun: MarkitdownRun = async (command, args) => {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([command, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { code: -1, stdout: "", stderr: (err as Error).message, notFound: true };
    }
    throw err;
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr, notFound: false };
};

/** Outcome of one extraction attempt (mapped to an HTTP status by the handler). */
export type ExtractOutcome =
  | { kind: "text"; text: string }
  | { kind: "unsupported" }
  | { kind: "failed"; detail: string }
  | { kind: "not-installed" };

/**
 * Convert one document's bytes to text by spawning markitdown on a temp file
 * named with the source extension (so markitdown dispatches by format). The ML
 * runs entirely in the subprocess (ADR-0006). Extensions outside
 * EXTRACTABLE_EXTENSIONS short-circuit to `unsupported` without a spawn.
 */
export async function runExtraction(
  bytes: Uint8Array,
  filename: string,
  deps: ExtractServeDeps = {},
): Promise<ExtractOutcome> {
  const ext = extname(filename).toLowerCase();
  if (!EXTRACTABLE_EXTENSIONS.has(ext)) return { kind: "unsupported" };

  const command = deps.command ?? DEFAULT_MARKITDOWN_COMMAND;
  const run = deps.run ?? defaultMarkitdownRun;
  const tmpPath = join(deps.tmpDir ?? tmpdir(), `suasor-extract-${randomUUID()}${ext}`);
  try {
    await writeFile(tmpPath, bytes);
    const result = await run(command, [tmpPath]);
    if (result.notFound) return { kind: "not-installed" };
    if (result.code !== 0) {
      const detail = (result.stderr.trim() || `markitdown exited ${result.code}`).slice(0, 500);
      return { kind: "failed", detail };
    }
    return { kind: "text", text: result.stdout };
  } finally {
    await rm(tmpPath, { force: true }).catch(() => {});
  }
}

/** Probe whether the markitdown CLI is reachable (spawns `<command> --version`). */
export async function probeMarkitdown(deps: ExtractServeDeps = {}): Promise<boolean> {
  const command = deps.command ?? DEFAULT_MARKITDOWN_COMMAND;
  const run = deps.run ?? defaultMarkitdownRun;
  const result = await run(command, ["--version"]);
  return !result.notFound;
}

/** Handler dependencies: extraction deps plus an optional diagnostic logger. */
export interface ExtractHandlerDeps extends ExtractServeDeps {
  /** Diagnostic sink for failed / missing-binary requests (stderr in the CLI). */
  log?: (message: string) => void;
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * Build the `fetch` handler implementing the extraction contract. `GET /health`
 * is a readiness probe; `POST /extract` reads raw bytes + the `x-filename` header
 * and returns `{ text }` / `{ text: null }` / a structured error.
 */
export function createExtractHandler(
  deps: ExtractHandlerDeps = {},
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse(200, { status: "ok" });
    }
    if (request.method !== "POST" || url.pathname !== "/extract") {
      return jsonResponse(404, { error: "not_found", detail: "POST /extract" });
    }

    const rawName = request.headers.get("x-filename") ?? "";
    let filename: string;
    try {
      filename = decodeURIComponent(rawName);
    } catch {
      filename = rawName; // tolerate a non-encoded header rather than 400
    }

    const bytes = new Uint8Array(await request.arrayBuffer());
    const outcome = await runExtraction(bytes, filename, deps);
    switch (outcome.kind) {
      case "text":
        return jsonResponse(200, { text: outcome.text });
      case "unsupported":
        return jsonResponse(200, { text: null });
      case "failed":
        deps.log?.(`extract failed for ${filename || "<unnamed>"}: ${outcome.detail}`);
        return jsonResponse(500, { error: "extraction_failed", detail: outcome.detail });
      case "not-installed":
        deps.log?.(
          `markitdown not found (command '${deps.command ?? DEFAULT_MARKITDOWN_COMMAND}')`,
        );
        return jsonResponse(503, {
          error: MARKITDOWN_INSTALL_HINT.code,
          message: MARKITDOWN_INSTALL_HINT.message,
          install: MARKITDOWN_INSTALL_HINT.install,
          docs: MARKITDOWN_INSTALL_HINT.docs,
        });
    }
  };
}

/** Resolved bind address for the sidecar. */
export interface ServeAddress {
  host: string;
  port: number;
}

/**
 * Resolve the bind host/port from `[extraction].baseUrl`, with optional CLI
 * overrides. Keeping the default in sync with `baseUrl` means the shipped shim
 * and the thin client agree with zero extra config.
 */
export function resolveServeAddress(
  baseUrl: string,
  hostOverride?: string,
  portOverride?: string,
): ServeAddress | { error: string } {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return { error: `invalid [extraction].baseUrl: ${baseUrl}` };
  }

  let port: number;
  if (portOverride !== undefined) {
    const n = Number(portOverride);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      return { error: "--port must be an integer in [1, 65535]" };
    }
    port = n;
  } else if (parsed.port !== "") {
    port = Number(parsed.port);
  } else {
    port = parsed.protocol === "https:" ? 443 : 80;
  }

  return { host: hostOverride ?? parsed.hostname, port };
}

/** A running sidecar handle. */
export interface ExtractionServer {
  url: string;
  port: number;
  stop: () => void;
}

/** Start the extraction sidecar on `host:port` (Bun.serve). */
export function startExtractionServer(options: {
  host: string;
  port: number;
  deps?: ExtractHandlerDeps;
}): ExtractionServer {
  const server = Bun.serve({
    hostname: options.host,
    port: options.port,
    fetch: createExtractHandler(options.deps ?? {}),
  });
  const port = server.port ?? options.port;
  return {
    url: `http://${options.host}:${port}`,
    port,
    stop: () => server.stop(true),
  };
}
