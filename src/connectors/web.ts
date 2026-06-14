/**
 * Web connector (ADR-0007). Read-only ingest of configured web pages (e.g.
 * operator / carrier sign-up pages) into `SourceRecord`s, using a headless
 * browser so client-rendered content is captured.
 *
 * - **read-only** — only navigation + DOM text extraction is performed; nothing
 *   is submitted or written back (ADR-0003).
 * - **delta** — there is no upstream delta API, so change detection is purely
 *   fingerprint-based (FR-ING-3): each snapshot's extracted text is hashed
 *   (SHA-256) and compared by the sync service, surfacing page diffs as updates.
 *   `finalize` returns `cursor: null`.
 * - **identity** — `web:<sha1(url)>` (cross-source-unique, stable per URL,
 *   ADR-0007). `source_type` is `web_page`.
 * - **import-clean** — `playwright-core` is **lazy-imported inside `sync`**, so
 *   building the connector / registry never pulls the SDK (ADR-0007, NFR-PRF-1).
 *   Top-level imports are limited to `zod`, `node:crypto`, + the contract types.
 * - **secrets** — none required; public pages only (no auth path here).
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  Connector,
  ConnectorConfig,
  SourceRecord,
  SyncContext,
  SyncResult,
} from "./contract.ts";

/** `[connectors.web]` config (docs/design/config.md). */
export const WebConnectorConfig = z.object({
  /** Page URLs to snapshot. */
  urls: z.array(z.string().url()).default([]),
  /** Headless browser channel/engine (forwarded to Playwright). */
  browser: z.enum(["chromium", "firefox", "webkit"]).default("chromium"),
});
export type WebConnectorConfig = z.infer<typeof WebConnectorConfig>;

export const WEB_CONNECTOR_NAME = "web";

/** A captured page snapshot the connector maps into a record. */
export interface WebSnapshot {
  url: string;
  /** Page title (when available). */
  title: string;
  /** Extracted visible text held locally. */
  text: string;
  /** Capture time (ISO 8601). */
  observedAt: string;
}

/** Stable per-URL id component (SHA-1 of the URL, hex). */
function urlId(url: string): string {
  return createHash("sha1").update(url).digest("hex");
}

/** Build a `SourceRecord` for one page snapshot. */
function toRecord(snap: WebSnapshot): SourceRecord {
  const body = snap.title && snap.text ? `${snap.title}\n\n${snap.text}` : snap.title || snap.text;
  return {
    externalId: `web:${urlId(snap.url)}`,
    sourceType: "web_page",
    body,
    observedAt: snap.observedAt,
    meta: { url: snap.url, title: snap.title },
  };
}

/**
 * The snapshot surface we depend on: render a URL and return its text snapshot.
 * Declared structurally so tests inject a fake without launching a browser and
 * so Playwright is lazy-loaded.
 */
export interface WebSnapshotterLike {
  snapshot(url: string): Promise<WebSnapshot>;
  /** Release browser resources once the run is done. */
  close(): Promise<void>;
}

/** How the connector obtains a snapshotter (overridable in tests). */
export type WebSnapshotterFactory = (options: {
  browser: WebConnectorConfig["browser"];
  now: () => Date;
}) => Promise<WebSnapshotterLike> | WebSnapshotterLike;

/**
 * Default factory: lazy-imports `playwright-core`, launching a headless browser
 * and extracting `document.body.innerText` per page. Kept out of the top level so
 * registration stays import-clean (ADR-0007).
 */
const defaultWebSnapshotterFactory: WebSnapshotterFactory = async ({ browser, now }) => {
  const playwright = await import("playwright-core");
  const engine = playwright[browser];
  const instance = await engine.launch({ headless: true });
  return {
    async snapshot(url) {
      const page = await instance.newPage();
      try {
        await page.goto(url, { waitUntil: "networkidle" });
        const title = await page.title();
        // Evaluated in the browser context (DOM globals exist there, not in the
        // Node typecheck lib), so pass the function as a string to avoid pulling
        // the DOM lib into this module's compilation.
        const text = (await page.evaluate(
          "document.body ? document.body.innerText : ''",
        )) as string;
        return { url, title, text, observedAt: now().toISOString() };
      } finally {
        await page.close();
      }
    },
    async close() {
      await instance.close();
    },
  };
};

export interface WebConnectorOptions {
  /** Snapshotter factory override (tests inject a fake; default lazy-imports Playwright). */
  snapshotterFactory?: WebSnapshotterFactory;
  /** Clock injection for deterministic snapshot timestamps in tests. */
  now?: () => Date;
}

/** Web connector implementing the read-only contract (ADR-0007). */
class WebConnector implements Connector {
  readonly name = WEB_CONNECTOR_NAME;
  readonly sourceType = "web";

  constructor(
    private readonly config: WebConnectorConfig,
    private readonly snapshotterFactory: WebSnapshotterFactory,
    private readonly now: () => Date,
  ) {}

  async *sync(_ctx: SyncContext): AsyncIterable<SourceRecord> {
    if (this.config.urls.length === 0) return;

    const snapshotter = await this.snapshotterFactory({
      browser: this.config.browser,
      now: this.now,
    });
    try {
      for (const url of this.config.urls) {
        const snap = await snapshotter.snapshot(url);
        yield toRecord(snap);
      }
    } finally {
      await snapshotter.close();
    }
  }

  finalize(): SyncResult {
    // Fingerprint-based change detection; no per-run cursor to persist.
    return { cursor: null };
  }
}

/**
 * Build the Web connector from its config slice (validates with Zod).
 * `playwright-core` is not imported here — only when `sync` actually runs.
 */
export function createWebConnector(
  config: ConnectorConfig,
  options: WebConnectorOptions = {},
): Connector {
  const parsed = WebConnectorConfig.parse(config ?? {});
  return new WebConnector(
    parsed,
    options.snapshotterFactory ?? defaultWebSnapshotterFactory,
    options.now ?? (() => new Date()),
  );
}
