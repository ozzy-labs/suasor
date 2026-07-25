/**
 * `sync.status` read tool (Issue #442).
 *
 * The gap this closes: `sync_runs` has recorded every run since ADR-0033, but
 * only `suasor sync status` ever read it — an agent answering a question had no
 * way to notice that its store stopped updating a week ago, so a broken cron
 * entry produced confident, silently stale answers. These tests pin that the
 * tool reports the runs *and* a verdict, and that the verdict is only invented
 * when the host actually supplied the cadence context.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../../src/db/index.ts";
import { buildMcpServer } from "../../src/mcp/server.ts";

let store: Store;

beforeEach(() => {
  store = Store.open({ path: ":memory:" });
});

afterEach(() => {
  store.close();
});

/** Record a completed run for `connector` that ended `hoursAgo` hours ago. */
function recordRun(
  connector: string,
  hoursAgo: number,
  status: "ok" | "partial" | "error" = "ok",
): void {
  const endedAt = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
  const startedAt = new Date(endedAt.getTime() - 1000);
  store.record(
    {
      type: "SyncRunStarted",
      runId: `${connector}:${startedAt.toISOString()}`,
      connector,
      startedAt: startedAt.toISOString(),
    },
    startedAt,
  );
  // `ended_at` is folded from the event's recordedAt (ADR-0033), so the store
  // clock is what back-dates a run — not a payload field.
  store.record(
    {
      type: "SyncRunEnded",
      runId: `${connector}:${startedAt.toISOString()}`,
      connector,
      status,
      observed: 3,
      updated: 1,
      unchanged: 0,
      durationMs: 1000,
      ...(status === "error" ? { error: "token revoked" } : {}),
    },
    endedAt,
  );
}

type SyncConfig = {
  enabledConnectors: string[];
  expectedIntervalHours: number;
  safetyFactor: number;
  perConnectorIntervalHours: Record<string, number>;
};

async function connect(sync?: SyncConfig): Promise<Client> {
  const server = buildMcpServer({
    sqlite: store.connection.sqlite,
    embedding: "disabled",
    ...(sync !== undefined ? { sync } : {}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function call(
  client: Client,
  args: Record<string, unknown> = {},
): Promise<{
  runs: Array<{ connector: string; status: string }>;
  freshness: Array<{ connector: string; state: string; ageHours: number | null }> | null;
  stale: string[] | null;
}> {
  const res = (await client.callTool({ name: "sync.status", arguments: args })) as {
    content: Array<{ type: string; text?: string }>;
  };
  return JSON.parse(res.content[0]?.text ?? "");
}

const CADENCE: SyncConfig = {
  enabledConnectors: ["slack", "github"],
  expectedIntervalHours: 1,
  safetyFactor: 2,
  perConnectorIntervalHours: {},
};

describe("sync.status (Issue #442)", () => {
  test("reports the latest run per connector with a freshness verdict", async () => {
    recordRun("slack", 0);
    recordRun("github", 10);
    const result = await call(await connect(CADENCE));
    expect(result.runs.map((r) => r.connector).sort()).toEqual(["github", "slack"]);
    const byConnector = new Map(result.freshness?.map((f) => [f.connector, f]) ?? []);
    expect(byConnector.get("slack")?.state).toBe("ok");
    // 10h against a 1h × 2 threshold.
    expect(byConnector.get("github")?.state).toBe("stale");
    expect(result.stale).toEqual(["github"]);
  });

  test("a configured connector that never synced is reported, not omitted", async () => {
    recordRun("slack", 0);
    const result = await call(await connect(CADENCE));
    expect(result.freshness?.find((f) => f.connector === "github")?.state).toBe("never");
    expect(result.stale).toEqual(["github"]);
  });

  test("a failed run surfaces as failing even when it is recent", async () => {
    recordRun("slack", 0, "error");
    recordRun("github", 0);
    const result = await call(await connect(CADENCE));
    expect(result.freshness?.find((f) => f.connector === "slack")?.state).toBe("failing");
  });

  test("staleOnly filters the verdict list but keeps the full stale roster", async () => {
    recordRun("slack", 0);
    recordRun("github", 10);
    const result = await call(await connect(CADENCE), { staleOnly: true });
    expect(result.freshness?.map((f) => f.connector)).toEqual(["github"]);
    expect(result.stale).toEqual(["github"]);
  });

  test("everything current yields an empty stale roster", async () => {
    recordRun("slack", 0);
    recordRun("github", 0);
    const result = await call(await connect(CADENCE));
    expect(result.stale).toEqual([]);
    expect(result.freshness?.every((f) => f.state === "ok")).toBe(true);
  });

  test("without cadence context it reports runs and declines to invent a verdict", async () => {
    recordRun("slack", 500);
    const result = await call(await connect());
    expect(result.runs).toHaveLength(1);
    expect(result.freshness).toBeNull();
    expect(result.stale).toBeNull();
  });
});

describe("brief sync_stale warning (Issue #442)", () => {
  test("a stale connector adds the warning to the brief bundle", async () => {
    recordRun("slack", 100);
    recordRun("github", 0);
    const client = await connect(CADENCE);
    const res = (await client.callTool({ name: "brief", arguments: {} })) as {
      content: Array<{ type: string; text?: string }>;
    };
    const brief = JSON.parse(res.content[0]?.text ?? "") as {
      warnings: Array<{ key: string; message: string }>;
    };
    const stale = brief.warnings.find((w) => w.key === "sync_stale");
    expect(stale?.message).toContain("slack (100h old)");
  });

  test("no warning when every enabled connector is current", async () => {
    recordRun("slack", 0);
    recordRun("github", 0);
    const client = await connect(CADENCE);
    const res = (await client.callTool({ name: "brief", arguments: {} })) as {
      content: Array<{ type: string; text?: string }>;
    };
    const brief = JSON.parse(res.content[0]?.text ?? "") as { warnings: Array<{ key: string }> };
    expect(brief.warnings.map((w) => w.key)).not.toContain("sync_stale");
  });
});
