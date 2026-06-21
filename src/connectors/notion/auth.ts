/**
 * Notion credential validation for `notion auth test` (Issue #85 pattern,
 * ADR-0011 §運用 verb generalized to non-Slack connectors).
 *
 * The notion connector authenticates with an integration token (the keychain
 * secret `token`). This verb proves the token is live by calling
 * `GET /v1/users/me` — the lightest authenticated Notion read — and reports the
 * resolved bot / integration identity so the operator can confirm which identity
 * the connector ingests as.
 *
 * Import-clean (ADR-0007): no SDK. The default transport uses the global `fetch`
 * (same pattern as `src/connectors/box/auth.ts`), wrapped in the shared
 * {@link fetchWithRetry} so a transient 429/5xx (with `Retry-After` honoured) is
 * retried rather than failing the check (Issue #269). The token is never echoed in
 * thrown errors.
 */
import {
  DEFAULT_CONNECTOR_TIMEOUT_MS,
  type FetchWithRetryOptions,
  fetchWithRetry,
} from "../../util/retry.ts";
import { NOTION_API_VERSION } from "./client.ts";

/** Identity resolved from a successful `GET /v1/users/me`. */
export interface NotionAuthResult {
  /** Bot / integration display name, when present. */
  readonly name: string;
  /** The owning workspace name, when present. */
  readonly workspaceName: string;
}

/** One identity round-trip, decoupled from `fetch` so tests inject a fake. */
export type NotionAuthTransport = (
  token: string,
) => Promise<{ status: number; body: Record<string, unknown> }>;

/**
 * Build the default transport: a `GET /v1/users/me`, run through
 * {@link fetchWithRetry} so a transient 429/5xx is retried (Issue #269). `retry`
 * is injectable (`fetchImpl` / `sleep`) so a test can drive
 * "429 → Retry-After → success" with no real waiting.
 */
export function makeDefaultTransport(retry: FetchWithRetryOptions = {}): NotionAuthTransport {
  const opts = { timeoutMs: DEFAULT_CONNECTOR_TIMEOUT_MS, ...retry };
  return async (token) => {
    const res = await fetchWithRetry(
      "https://api.notion.com/v1/users/me",
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_API_VERSION },
      },
      opts,
    );
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      // Non-JSON error body → leave empty; status drives the verdict.
    }
    return { status: res.status, body };
  };
}

const defaultTransport: NotionAuthTransport = makeDefaultTransport();

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Verify a Notion integration token by resolving the bot identity.
 *
 * @throws {Error} when `GET /v1/users/me` returns a non-2xx (message carries the
 *   HTTP status + Notion `message`, never the token).
 */
export async function testNotionAuth(
  token: string,
  transport: NotionAuthTransport = defaultTransport,
): Promise<NotionAuthResult> {
  const { status, body } = await transport(token);
  if (status < 200 || status >= 300) {
    const detail = asString(body.message) || `HTTP ${status}`;
    throw new Error(`notion GET /v1/users/me failed: ${status} ${detail}`);
  }
  // `users/me` for an integration returns a bot user; the workspace name lives on
  // `bot.workspace_name`.
  const bot = body.bot && typeof body.bot === "object" ? (body.bot as Record<string, unknown>) : {};
  return {
    name: asString(body.name),
    workspaceName: asString(bot.workspace_name),
  };
}
