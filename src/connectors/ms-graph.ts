/**
 * Microsoft Graph connector (ADR-0007). Read-only ingest across the Microsoft
 * 365 surface — Outlook mail, Calendar, OneDrive files, and Teams channel
 * messages — into `SourceRecord`s.
 *
 * - **read-only** — only Graph `GET` collection endpoints are called; nothing is
 *   written back (ADR-0003).
 * - **delta** — Graph collections are paged via `@odata.nextLink`. The connector
 *   walks every page each run and relies on the body fingerprint (sync service
 *   SHA-256) for change detection (FR-ING-3); no per-run cursor is stored, so
 *   `finalize` returns `cursor: null` like other fingerprint-based connectors.
 * - **identity** — `msgraph:<resource>:<id>` (cross-source-unique, resource-
 *   prefixed, ADR-0007). `source_type` is one of `ms365_mail`, `ms365_calendar`,
 *   `ms365_file`, `ms365_teams_message`.
 * - **import-clean** — `@microsoft/microsoft-graph-client` + `@azure/msal-node`
 *   are **lazy-imported inside `sync`**, so building the connector / registry
 *   never pulls the SDKs (ADR-0007, NFR-PRF-1). Top-level imports are limited to
 *   `zod` + the contract types.
 * - **secrets** — the client secret comes from `ctx.secret("clientSecret")`
 *   (keychain + env override, NFR-PRV-4); tenant/client ids live in config.
 */
import { z } from "zod";
import type {
  Connector,
  ConnectorConfig,
  SourceRecord,
  SyncContext,
  SyncResult,
} from "./contract.ts";

/** Graph resource families this connector can ingest. */
export const MsGraphResource = z.enum(["mail", "calendar", "files", "teams"]);
export type MsGraphResource = z.infer<typeof MsGraphResource>;

/** `[connectors.ms-graph]` config (docs/design/config.md). */
export const MsGraphConnectorConfig = z.object({
  /** Azure AD tenant id (directory id). */
  tenantId: z.string().min(1).default(""),
  /** App registration (client) id. */
  clientId: z.string().min(1).default(""),
  /** User principal name / id whose mailbox & drive are read (app-only flow). */
  user: z.string().min(1).default("me"),
  /** Resource families to ingest. */
  resources: z.array(MsGraphResource).default(["mail", "calendar"]),
});
export type MsGraphConnectorConfig = z.infer<typeof MsGraphConnectorConfig>;

export const MS_GRAPH_CONNECTOR_NAME = "ms-graph";

/** Minimal Graph item shape (the fields we map). */
interface GraphItem {
  id: string;
  subject?: string;
  bodyPreview?: string;
  body?: { content?: string };
  name?: string;
  lastModifiedDateTime?: string;
  receivedDateTime?: string;
  start?: { dateTime?: string };
  createdDateTime?: string;
}

/** A Graph collection page (OData). */
interface GraphPage {
  value: GraphItem[];
  "@odata.nextLink"?: string;
}

/**
 * Map a Graph resource family to its (`source_type`, list path) pair. The path
 * is relative to the Graph base; `{user}` is substituted from config.
 */
const RESOURCE_SPEC: Record<MsGraphResource, { sourceType: string; path: (user: string) => string }> =
  {
    mail: {
      sourceType: "ms365_mail",
      path: (u) => `/users/${u}/messages?$top=50&$select=id,subject,bodyPreview,receivedDateTime`,
    },
    calendar: {
      sourceType: "ms365_calendar",
      path: (u) => `/users/${u}/events?$top=50&$select=id,subject,bodyPreview,start`,
    },
    files: {
      sourceType: "ms365_file",
      path: (u) =>
        `/users/${u}/drive/root/children?$top=50&$select=id,name,lastModifiedDateTime`,
    },
    teams: {
      sourceType: "ms365_teams_message",
      path: (u) => `/users/${u}/chats/getAllMessages?$top=50`,
    },
  };

/** Build a `SourceRecord` for one Graph item of a resource family. */
function toRecord(resource: MsGraphResource, item: GraphItem): SourceRecord {
  const spec = RESOURCE_SPEC[resource];
  const title = item.subject ?? item.name ?? "";
  const detail = item.body?.content ?? item.bodyPreview ?? "";
  const body = title && detail ? `${title}\n\n${detail}` : title || detail;
  const observedAt =
    item.lastModifiedDateTime ??
    item.receivedDateTime ??
    item.start?.dateTime ??
    item.createdDateTime ??
    new Date(0).toISOString();
  return {
    externalId: `msgraph:${resource}:${item.id}`,
    sourceType: spec.sourceType,
    body,
    observedAt,
    meta: { resource, id: item.id },
  };
}

/**
 * The Graph client surface we depend on: fetch a JSON page for a relative API
 * path. Declared structurally so tests inject a fake without the SDK and so the
 * real client is lazy-loaded.
 */
export interface MsGraphClientLike {
  /** GET a Graph collection page by relative path (or an absolute nextLink). */
  getPage(path: string): Promise<GraphPage>;
}

/** How the connector obtains a Graph client (overridable in tests). */
export type MsGraphClientFactory = (auth: {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}) => Promise<MsGraphClientLike> | MsGraphClientLike;

/**
 * Default factory: lazy-imports `@azure/msal-node` for an app-only token and
 * `@microsoft/microsoft-graph-client` for the request surface. Kept out of the
 * top level so registration stays import-clean (ADR-0007).
 */
const defaultMsGraphClientFactory: MsGraphClientFactory = async ({
  tenantId,
  clientId,
  clientSecret,
}) => {
  const { ConfidentialClientApplication } = await import("@azure/msal-node");
  const { Client } = await import("@microsoft/microsoft-graph-client");
  const msal = new ConfidentialClientApplication({
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${tenantId}`,
      clientSecret,
    },
  });
  const client = Client.initWithMiddleware({
    authProvider: {
      getAccessToken: async () => {
        const result = await msal.acquireTokenByClientCredential({
          scopes: ["https://graph.microsoft.com/.default"],
        });
        if (!result?.accessToken) throw new Error("ms-graph connector: token acquisition failed");
        return result.accessToken;
      },
    },
  });
  return {
    async getPage(path) {
      // `client.api` accepts both a relative resource path and an absolute
      // `@odata.nextLink`, so the same call covers first page and pagination.
      return (await client.api(path).get()) as GraphPage;
    },
  };
};

export interface MsGraphConnectorOptions {
  /** Graph client factory override (tests inject a fake; default lazy-imports the SDKs). */
  clientFactory?: MsGraphClientFactory;
}

/** Microsoft Graph connector implementing the read-only contract (ADR-0007). */
class MsGraphConnector implements Connector {
  readonly name = MS_GRAPH_CONNECTOR_NAME;
  readonly sourceType = "ms365";

  constructor(
    private readonly config: MsGraphConnectorConfig,
    private readonly clientFactory: MsGraphClientFactory,
  ) {}

  async *sync(ctx: SyncContext): AsyncIterable<SourceRecord> {
    if (this.config.resources.length === 0) return;

    const clientSecret = await ctx.secret("clientSecret");
    if (!clientSecret) {
      throw new Error(
        "ms-graph connector: no clientSecret configured " +
          "(set SUASOR_CONNECTOR_MS_GRAPH_CLIENTSECRET or store it in the OS keychain)",
      );
    }
    if (!this.config.tenantId || !this.config.clientId) {
      throw new Error("ms-graph connector: tenantId and clientId are required in config");
    }

    const client = await this.clientFactory({
      tenantId: this.config.tenantId,
      clientId: this.config.clientId,
      clientSecret,
    });

    for (const resource of this.config.resources) {
      let path: string | undefined = RESOURCE_SPEC[resource].path(this.config.user);
      while (path) {
        const page: GraphPage = await client.getPage(path);
        for (const item of page.value ?? []) {
          yield toRecord(resource, item);
        }
        path = page["@odata.nextLink"];
      }
    }
  }

  finalize(): SyncResult {
    // Fingerprint-based change detection; no per-run cursor to persist.
    return { cursor: null };
  }
}

/**
 * Build the Microsoft Graph connector from its config slice (validates with Zod).
 * The Graph + MSAL SDKs are not imported here — only when `sync` actually runs.
 */
export function createMsGraphConnector(
  config: ConnectorConfig,
  options: MsGraphConnectorOptions = {},
): Connector {
  const parsed = MsGraphConnectorConfig.parse(config ?? {});
  return new MsGraphConnector(parsed, options.clientFactory ?? defaultMsGraphClientFactory);
}
