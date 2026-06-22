/**
 * Structured MCP tool errors + startup readiness (ADR-0031).
 *
 * MCP tool failures used to surface as a bare string with no machine-readable
 * `code` or actionable `hint`, so a host (Claude Code / Desktop / …) could not
 * tell "your input was wrong" from "the server is mis-configured" from "the
 * entity does not exist". This module gives every tool error a small, stable
 * shape — `{ code, message, hint }` — carried inside the MCP `isError` content
 * block as JSON, so hosts can branch on `code` and show `hint` to the user.
 *
 * It also provides startup `readiness` verification: critical config (e.g. the
 * SQLite db path) is validated when `serveMcp` boots, so a fatal mis-config
 * fails fast with a `code`/`hint` instead of crashing deep inside a later tool
 * call (the original `[export].dir` fail-on-call anti-pattern — Issue #196).
 *
 * Read = no behavioural change: read tools never threw, so they need no codes.
 * The taxonomy targets the write half + boot.
 */

/**
 * Machine-readable tool error codes (ADR-0031). Stable strings: hosts branch on
 * them, so renames are breaking. Grouped by cause so a host can pick a UI:
 *
 * Input / validation:
 *  - `INVALID_INPUT`            — the arguments are malformed beyond what the
 *    Zod input schema already rejects (e.g. a self-loop link, a self-merge).
 *
 * State-machine violations:
 *  - `INVALID_STATE`            — the entity exists but is not in a state that
 *    permits this transition (e.g. triaging a non-`open` inbox item).
 *
 * Missing entities:
 *  - `MISSING_ENTITY`           — the referenced entity does not exist (e.g.
 *    an unknown link id, an unknown inbox item).
 *
 * Configuration (per-call + boot):
 *  - `EXPORT_DIR_NOT_CONFIGURED`— `draft.export` was called but `[export].dir`
 *    is unset.
 *  - `CONFIG_INVALID`           — critical config is missing/invalid at boot or
 *    call time (e.g. `storage.dbPath` unset).
 *
 * Connector:
 *  - `UNKNOWN_CONNECTOR`        — `connector.sync` named a connector with no
 *    registered driver.
 *
 * Fallback:
 *  - `INTERNAL`                 — an unexpected failure with no better code.
 */
export type McpErrorCode =
  | "INVALID_INPUT"
  | "INVALID_STATE"
  | "MISSING_ENTITY"
  | "EXPORT_DIR_NOT_CONFIGURED"
  | "CONFIG_INVALID"
  | "UNKNOWN_CONNECTOR"
  // Task external-home management (ADR-0036).
  | "ACTUATOR_NOT_CONFIGURED"
  | "PUBLISH_DESTINATION_INVALID"
  | "EGRESS_FAILED"
  | "INTERNAL";

/** The serialized body carried inside an `isError` tool result. */
export interface McpErrorBody {
  /** Stable machine-readable code (host branches on this). */
  code: McpErrorCode;
  /** Human-readable description of what went wrong. */
  message: string;
  /** Actionable next step for the user/host (how to fix it). */
  hint?: string;
}

/**
 * A domain error carrying a structured {@link McpErrorCode} + hint. Handlers (or
 * the services they call) throw this; {@link toToolError} turns it into an MCP
 * `isError` result. `serveMcp` also throws it at boot for fatal mis-config.
 */
export class McpToolError extends Error {
  readonly code: McpErrorCode;
  readonly hint?: string;

  constructor(code: McpErrorCode, message: string, hint?: string) {
    super(message);
    this.name = "McpToolError";
    this.code = code;
    if (hint !== undefined) this.hint = hint;
  }

  /** The serializable `{ code, message, hint }` body. */
  body(): McpErrorBody {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint !== undefined ? { hint: this.hint } : {}),
    };
  }
}

/** The MCP tool result shape for an error (mirrors `jsonResult` for success). */
export interface ToolErrorResult {
  isError: true;
  content: { type: "text"; text: string }[];
}

/**
 * Build an MCP `isError` result from a structured error body. The JSON body is
 * the single text content block so a host can `JSON.parse` it and branch on
 * `code`; the `message` stays human-readable for hosts that only show text.
 */
export function toolError(body: McpErrorBody): ToolErrorResult {
  return { isError: true, content: [{ type: "text", text: JSON.stringify(body) }] };
}

/**
 * Map an arbitrary thrown value to a structured MCP error result. A
 * {@link McpToolError} keeps its code/hint; any other `Error` degrades to
 * `INTERNAL` with its message (so a crash still surfaces as a structured tool
 * error rather than tearing down the connection). Non-`Error` throws stringify.
 */
export function toToolError(error: unknown): ToolErrorResult {
  if (error instanceof McpToolError) return toolError(error.body());
  if (error instanceof Error) return toolError({ code: "INTERNAL", message: error.message });
  return toolError({ code: "INTERNAL", message: String(error) });
}

/** A single readiness finding: a fatal mis-config blocking boot/use. */
export interface ReadinessIssue {
  code: McpErrorCode;
  message: string;
  hint: string;
}

/**
 * Minimal config slice {@link verifyReadiness} inspects at boot. Kept structural
 * so `serveMcp` can pass its resolved `Config` (and tests a fake) without a hard
 * dependency on the full schema.
 */
export interface ReadinessConfig {
  storage: { dbPath: string | null };
}

/**
 * Verify critical config at startup (ADR-0031). Returns the list of fatal
 * issues; an empty list means ready. Currently fatal:
 *  - `storage.dbPath` unset → no store can be opened (`CONFIG_INVALID`).
 *
 * `[export].dir` is intentionally NOT fatal here: `draft.export` is one optional
 * write tool, so a missing export dir degrades to a per-call
 * `EXPORT_DIR_NOT_CONFIGURED` error rather than blocking the whole server.
 */
export function verifyReadiness(config: ReadinessConfig): ReadinessIssue[] {
  const issues: ReadinessIssue[] = [];
  if (config.storage.dbPath === null) {
    issues.push({
      code: "CONFIG_INVALID",
      message: "storage.dbPath is not configured",
      hint: "Set [storage].dbPath in your config (run `suasor onboard` to scaffold it).",
    });
  }
  return issues;
}
