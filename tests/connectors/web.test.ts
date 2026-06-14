import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { SourceRecord, SyncContext } from "../../src/connectors/contract.ts";
import {
  createWebConnector,
  type WebSnapshot,
  type WebSnapshotterLike,
  WebConnectorConfig,
} from "../../src/connectors/web.ts";

function fakeSnapshotter(byUrl: Record<string, { title: string; text: string }>): {
  factory: () => WebSnapshotterLike;
  closed: () => boolean;
} {
  let didClose = false;
  const factory = () => {
    const snapshotter: WebSnapshotterLike = {
      async snapshot(url): Promise<WebSnapshot> {
        const page = byUrl[url] ?? { title: "", text: "" };
        return { url, title: page.title, text: page.text, observedAt: "2026-06-14T00:00:00.000Z" };
      },
      async close() {
        didClose = true;
      },
    };
    return snapshotter;
  };
  return { factory, closed: () => didClose };
}

const ctx: SyncContext = { cursor: null, secret: async () => null };

async function collect(it: AsyncIterable<SourceRecord>): Promise<SourceRecord[]> {
  const out: SourceRecord[] = [];
  for await (const r of it) out.push(r);
  return out;
}

describe("WebConnectorConfig", () => {
  test("defaults: empty urls, chromium", () => {
    const c = WebConnectorConfig.parse({});
    expect(c.urls).toEqual([]);
    expect(c.browser).toBe("chromium");
  });
  test("rejects non-URL entries", () => {
    expect(() => WebConnectorConfig.parse({ urls: ["not a url"] })).toThrow();
  });
});

describe("Web connector — record mapping (ADR-0007 identity)", () => {
  test("maps a page snapshot to web_page with a stable url-hash id", async () => {
    const url = "https://operator.example.com/signup";
    const { factory } = fakeSnapshotter({ [url]: { title: "Sign up", text: "fill the form" } });
    const connector = createWebConnector({ urls: [url] }, { snapshotterFactory: factory });
    const records = await collect(connector.sync(ctx));
    expect(records).toHaveLength(1);
    const expectedId = `web:${createHash("sha1").update(url).digest("hex")}`;
    expect(records[0]?.externalId).toBe(expectedId);
    expect(records[0]?.sourceType).toBe("web_page");
    expect(records[0]?.body).toBe("Sign up\n\nfill the form");
    expect(records[0]?.meta).toMatchObject({ url, title: "Sign up" });
  });
});

describe("Web connector — fingerprint diff (FR-ING-3)", () => {
  test("body changes between snapshots so the sync service detects a diff", async () => {
    const url = "https://operator.example.com/terms";
    const before = createWebConnector(
      { urls: [url] },
      { snapshotterFactory: fakeSnapshotter({ [url]: { title: "Terms", text: "v1" } }).factory },
    );
    const after = createWebConnector(
      { urls: [url] },
      { snapshotterFactory: fakeSnapshotter({ [url]: { title: "Terms", text: "v2 updated" } }).factory },
    );
    const [b] = await collect(before.sync(ctx));
    const [a] = await collect(after.sync(ctx));
    expect(b?.externalId).toBe(a?.externalId); // same identity
    expect(b?.body).not.toBe(a?.body); // different body → fingerprint differs downstream
    expect((await before.finalize?.())?.cursor).toBeNull();
  });

  test("closes the snapshotter after the run", async () => {
    const url = "https://e.com/";
    const fake = fakeSnapshotter({ [url]: { title: "t", text: "x" } });
    const connector = createWebConnector({ urls: [url] }, { snapshotterFactory: fake.factory });
    await collect(connector.sync(ctx));
    expect(fake.closed()).toBe(true);
  });
});

describe("Web connector — guards", () => {
  test("no urls yields nothing (and never builds a snapshotter)", async () => {
    let built = false;
    const connector = createWebConnector(
      { urls: [] },
      {
        snapshotterFactory: () => {
          built = true;
          return fakeSnapshotter({}).factory();
        },
      },
    );
    expect(await collect(connector.sync(ctx))).toEqual([]);
    expect(built).toBe(false);
  });
});
