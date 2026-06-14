/**
 * Remaining-connector e2e (Issue #14 test plan): for each connector, drive it
 * through the shared sync service with a mock SDK, then assert the ingested body
 * is searchable via the same FTS-first retrieval the `search` CLI / MCP use —
 * exercising the full ingest → event → projection → search vertical slice and
 * the per-connector identity / source_type mapping (ADR-0007).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createBoxConnector } from "../../src/connectors/box.ts";
import { createGoogleConnector } from "../../src/connectors/google.ts";
import { createMsGraphConnector } from "../../src/connectors/ms-graph.ts";
import { createSlackConnector } from "../../src/connectors/slack.ts";
import { createWebConnector } from "../../src/connectors/web.ts";
import { syncConnector } from "../../src/connectors/index.ts";
import { Store } from "../../src/db/index.ts";
import { searchSources } from "../../src/retrieval/index.ts";

let store: Store;
beforeEach(() => {
  store = Store.open({ path: ":memory:" });
});
afterEach(() => {
  store.close();
});

describe("Slack: sync → projection → FTS", () => {
  test("ingested message is searchable and re-running is idempotent", async () => {
    const connector = createSlackConnector(
      { team: "T1", channels: ["C1"] },
      {
        clientFactory: () => ({
          conversations: {
            history: async () => ({
              messages: [{ ts: "1700000000.000100", text: "rocket launch scheduled", user: "U1" }],
            }),
          },
        }),
      },
    );
    const out = await syncConnector(store, connector, {
      secrets: { env: { SUASOR_CONNECTOR_SLACK_TOKEN: "tok" } },
    });
    expect(out.observed).toBe(1);

    const hit = searchSources(store.connection.sqlite, "rocket").hits[0];
    expect(hit?.externalId).toBe("slack:T1:C1:1700000000.000100");
    expect(hit?.sourceType).toBe("slack_message");

    // Idempotent: same fingerprint → 0 observed, 0 updated on the second pass.
    const c2 = createSlackConnector(
      { team: "T1", channels: ["C1"] },
      {
        clientFactory: () => ({
          conversations: {
            history: async () => ({
              messages: [{ ts: "1700000000.000100", text: "rocket launch scheduled", user: "U1" }],
            }),
          },
        }),
      },
    );
    const out2 = await syncConnector(store, c2, {
      secrets: { env: { SUASOR_CONNECTOR_SLACK_TOKEN: "tok" } },
    });
    expect(out2).toMatchObject({ observed: 0, updated: 0, unchanged: 1 });
  });
});

describe("MS Graph: sync → projection → FTS", () => {
  test("ingested mail is searchable", async () => {
    const connector = createMsGraphConnector(
      { tenantId: "t", clientId: "c", user: "me", resources: ["mail"] },
      {
        clientFactory: () => ({
          getPage: async () => ({
            value: [{ id: "m1", subject: "Quarterly orbit review", bodyPreview: "agenda" }],
          }),
        }),
      },
    );
    const out = await syncConnector(store, connector, {
      secrets: { env: { SUASOR_CONNECTOR_MS_GRAPH_CLIENTSECRET: "s" } },
    });
    expect(out.observed).toBe(1);
    const hit = searchSources(store.connection.sqlite, "orbit").hits[0];
    expect(hit?.externalId).toBe("msgraph:mail:m1");
    expect(hit?.sourceType).toBe("ms365_mail");
  });
});

describe("Google: sync → projection → FTS", () => {
  test("ingested gmail message is searchable", async () => {
    const connector = createGoogleConnector(
      { resources: ["gmail"] },
      {
        clientFactory: () => ({
          listPage: async () => ({
            items: [
              { id: "g1", title: "Re: telescope", detail: "deploy the telescope", observedAt: "2026-06-10T00:00:00Z" },
            ],
          }),
        }),
      },
    );
    const out = await syncConnector(store, connector, {
      secrets: { env: { SUASOR_CONNECTOR_GOOGLE_REFRESHTOKEN: "rt" } },
    });
    expect(out.observed).toBe(1);
    const hit = searchSources(store.connection.sqlite, "telescope").hits[0];
    expect(hit?.externalId).toBe("google:gmail:g1");
    expect(hit?.sourceType).toBe("gmail_message");
  });
});

describe("Box: sync → projection → FTS (sha1 fingerprint)", () => {
  test("ingested file is searchable and sha1 drives delta detection", async () => {
    const connector = createBoxConnector(
      { folders: ["0"] },
      {
        clientFactory: () => ({
          listFolder: async () => ({
            files: [{ id: "11", name: "satellite-plan.pdf", sha1: "deadbeef" }],
          }),
        }),
      },
    );
    const out = await syncConnector(store, connector, {
      secrets: { env: { SUASOR_CONNECTOR_BOX_TOKEN: "tok" } },
    });
    expect(out.observed).toBe(1);
    const hit = searchSources(store.connection.sqlite, "satellite").hits[0];
    expect(hit?.externalId).toBe("box:file:11");
    expect(hit?.sourceType).toBe("box_file");

    // Same sha1 → unchanged on re-sync (fingerprint comes from Box, not the body).
    const c2 = createBoxConnector(
      { folders: ["0"] },
      {
        clientFactory: () => ({
          listFolder: async () => ({
            files: [{ id: "11", name: "satellite-plan.pdf", sha1: "deadbeef" }],
          }),
        }),
      },
    );
    const out2 = await syncConnector(store, c2, {
      secrets: { env: { SUASOR_CONNECTOR_BOX_TOKEN: "tok" } },
    });
    expect(out2.unchanged).toBe(1);
  });
});

describe("Web: sync → projection → FTS (fingerprint diff)", () => {
  test("page text is searchable; a changed snapshot is detected as an update", async () => {
    const url = "https://operator.example.com/signup";
    const mk = (text: string) =>
      createWebConnector(
        { urls: [url] },
        {
          snapshotterFactory: () => ({
            snapshot: async () => ({ url, title: "Signup", text, observedAt: "2026-06-14T00:00:00Z" }),
            close: async () => {},
          }),
        },
      );
    const out = await syncConnector(store, mk("fingerprint differs across operators"));
    expect(out.observed).toBe(1);
    const hit = searchSources(store.connection.sqlite, "fingerprint").hits[0];
    expect(hit?.sourceType).toBe("web_page");

    // Changed page text → SourceBodyUpdated (fingerprint diff, FR-ING-3).
    const out2 = await syncConnector(store, mk("the signup form changed entirely"));
    expect(out2.updated).toBe(1);
  });
});
