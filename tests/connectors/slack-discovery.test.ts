/**
 * Sync-time discovery-drift sweep (ADR-0039 Layer 2). The connector sweeps
 * `users.conversations` (public + private) after resolving each workspace's
 * token, diffs against the configured `channels`, and warns about newly-joined
 * conversations — without ingesting them or advancing any cursor. Network-free:
 * both the message client and the `users.conversations` transport are injected.
 */
import { describe, expect, test } from "bun:test";
import type { SourceRecord, SyncContext } from "../../src/connectors/contract.ts";
import type { SlackConversationsTransport } from "../../src/connectors/slack/conversations.ts";
import {
  createSlackConnector,
  cursorToAliasMap,
  readDiscoveryMarkers,
  type SlackClientLike,
} from "../../src/connectors/slack.ts";

/** A message client with a single empty history page (ingest is not the focus). */
function quietSlack(): SlackClientLike {
  return {
    conversations: {
      async history() {
        return { messages: [] };
      },
      async replies() {
        return { messages: [] };
      },
    },
  };
}

/** A `users.conversations` transport returning fixed rows per api `types` value. */
function fakeSweep(byType: Partial<Record<string, Record<string, unknown>[]>>): {
  transport: SlackConversationsTransport;
  calls: Record<string, string>[];
} {
  const calls: Record<string, string>[] = [];
  const transport: SlackConversationsTransport = async (_token, params) => {
    calls.push(params);
    return { ok: true, channels: byType[params.types as string] ?? [] };
  };
  return { transport, calls };
}

/** A throwing transport, to exercise the best-effort degrade path. */
const throwingSweep: SlackConversationsTransport = async () => {
  throw new Error("boom");
};

function ctx(overrides: Partial<SyncContext> = {}): SyncContext {
  return {
    cursor: null,
    secret: async (name) => (name === "token" ? "xoxb-tok" : null),
    ...overrides,
  };
}

async function drain(it: AsyncIterable<SourceRecord>): Promise<SourceRecord[]> {
  const out: SourceRecord[] = [];
  for await (const r of it) out.push(r);
  return out;
}

const HOUR = 60 * 60 * 1000;

describe("Slack connector — discovery drift sweep (ADR-0039 Layer 2)", () => {
  test("warns once about member conversations not in config; does not ingest them", async () => {
    const { transport, calls } = fakeSweep({
      // C1 is configured; C2 (member) is new; C3 is not a member → excluded.
      public_channel: [
        { id: "C1", name: "general", is_member: true },
        { id: "C2", name: "random", is_member: true },
        { id: "C3", name: "lurk", is_member: false },
      ],
      private_channel: [{ id: "G1", name: "secret", is_member: true }],
    });
    const warns: string[] = [];
    const connector = createSlackConnector(
      { channels: ["C1"] },
      { clientFactory: () => quietSlack(), conversationsTransport: transport, now: () => 0 },
    );
    const records = await drain(connector.sync(ctx({ onWarn: (m) => warns.push(m) })));

    // Nothing ingested by the sweep (empty history) — drift is warn-only.
    expect(records).toEqual([]);
    // C2 (member) + G1 (member) are new; C3 (non-member) is excluded.
    const driftWarn = warns.find((w) => w.includes("new conversation(s)"));
    expect(driftWarn).toBeDefined();
    expect(driftWarn).toContain("2 new conversation(s)");
    expect(driftWarn).toContain("slack conversations --new");
    // Only public + private are swept (im/mpim excluded by default, §3).
    expect(calls.map((c) => c.types).sort()).toEqual(["private_channel", "public_channel"]);
  });

  test("no new conversations → no drift warn (quiet)", async () => {
    const { transport } = fakeSweep({
      public_channel: [{ id: "C1", name: "general", is_member: true }],
    });
    const warns: string[] = [];
    const connector = createSlackConnector(
      { channels: ["C1"] },
      { clientFactory: () => quietSlack(), conversationsTransport: transport, now: () => 0 },
    );
    await drain(connector.sync(ctx({ onWarn: (m) => warns.push(m) })));
    expect(warns.some((w) => w.includes("new conversation(s)"))).toBe(false);
  });

  test("persists a drift marker (readable offline by doctor) without touching channel cursors", async () => {
    const { transport } = fakeSweep({
      public_channel: [
        { id: "C1", name: "general", is_member: true },
        { id: "C2", name: "random", is_member: true },
      ],
    });
    let saved: string | null = null;
    const connector = createSlackConnector(
      { channels: ["C1"] },
      { clientFactory: () => quietSlack(), conversationsTransport: transport, now: () => 5000 },
    );
    await drain(connector.sync(ctx({ onWarn: () => {} })));
    saved = (await connector.finalize?.())?.cursor ?? null;

    // The marker records the sweep time + new count, keyed by workspace alias.
    const markers = readDiscoveryMarkers(saved);
    expect(markers).toEqual([{ alias: "default", lastSweptMs: 5000, newCount: 1 }]);
    // The drift marker is invisible to the channel-cursor view (status/reset).
    expect(cursorToAliasMap(saved)).toEqual({});
  });

  test("cadence: a recent marker (<24h) skips the sweep; the marker is carried forward", async () => {
    const { transport, calls } = fakeSweep({
      public_channel: [{ id: "C2", name: "random", is_member: true }],
    });
    const warns: string[] = [];
    // Prior sweep at t=0; now = 1h later → within the 24h window, so no re-sweep.
    const prior = JSON.stringify({ default: { C1: "1.0" }, __discovery__: { default: "0:0" } });
    const connector = createSlackConnector(
      { channels: ["C1"] },
      { clientFactory: () => quietSlack(), conversationsTransport: transport, now: () => 1 * HOUR },
    );
    await drain(connector.sync(ctx({ cursor: prior, onWarn: (m) => warns.push(m) })));
    expect(calls.length).toBe(0); // no sweep call
    expect(warns.some((w) => w.includes("new conversation(s)"))).toBe(false);
    const saved = (await connector.finalize?.())?.cursor ?? null;
    // The old marker is preserved (still 0:0).
    expect(readDiscoveryMarkers(saved)).toEqual([
      { alias: "default", lastSweptMs: 0, newCount: 0 },
    ]);
  });

  test("cadence: an old marker (>24h) re-sweeps", async () => {
    const { transport, calls } = fakeSweep({
      public_channel: [{ id: "C2", name: "random", is_member: true }],
    });
    const prior = JSON.stringify({ default: { C1: "1.0" }, __discovery__: { default: "0:0" } });
    const connector = createSlackConnector(
      { channels: ["C1"] },
      {
        clientFactory: () => quietSlack(),
        conversationsTransport: transport,
        now: () => 25 * HOUR,
      },
    );
    await drain(connector.sync(ctx({ cursor: prior, onWarn: () => {} })));
    expect(calls.length).toBeGreaterThan(0);
    const saved = (await connector.finalize?.())?.cursor ?? null;
    expect(readDiscoveryMarkers(saved)).toEqual([
      { alias: "default", lastSweptMs: 25 * HOUR, newCount: 1 },
    ]);
  });

  test("opt-out: discover_new = false skips the sweep entirely", async () => {
    const { transport, calls } = fakeSweep({
      public_channel: [{ id: "C2", name: "random", is_member: true }],
    });
    const warns: string[] = [];
    const connector = createSlackConnector(
      { channels: ["C1"], discover_new: false },
      { clientFactory: () => quietSlack(), conversationsTransport: transport, now: () => 0 },
    );
    await drain(connector.sync(ctx({ onWarn: (m) => warns.push(m) })));
    expect(calls.length).toBe(0);
    expect(warns.some((w) => w.includes("new conversation(s)"))).toBe(false);
  });

  test("a channel-less (lists-only) workspace is not swept (no nag about every channel)", async () => {
    const { transport, calls } = fakeSweep({
      public_channel: [{ id: "C2", name: "random", is_member: true }],
    });
    const warns: string[] = [];
    // Lists-only: keeps the workspace in the sync pass, but there is no channel
    // config to drift against, so discovery must stay silent.
    const connector = createSlackConnector(
      { channels: [], lists: ["Lx"] },
      { clientFactory: () => quietSlack(), conversationsTransport: transport, now: () => 0 },
    );
    await drain(connector.sync(ctx({ onWarn: (m) => warns.push(m) })));
    expect(calls.length).toBe(0);
    expect(warns.some((w) => w.includes("new conversation(s)"))).toBe(false);
  });

  test("per-workspace override wins over the connector-level default", async () => {
    const { transport, calls } = fakeSweep({
      public_channel: [{ id: "C2", name: "random", is_member: true }],
    });
    const warns: string[] = [];
    const connector = createSlackConnector(
      {
        discover_new: true,
        workspaces: {
          acme: { team: "TA", channels: ["C1"], discover_new: false },
        },
      },
      {
        clientFactory: () => quietSlack(),
        conversationsTransport: transport,
        now: () => 0,
      },
    );
    await drain(
      connector.sync(
        ctx({
          secret: async (n) => (n === "acme:token" ? "xoxb" : null),
          onWarn: (m) => warns.push(m),
        }),
      ),
    );
    expect(calls.length).toBe(0); // acme opted out
    expect(warns.some((w) => w.includes("new conversation(s)"))).toBe(false);
  });

  test("best-effort: a sweep error warns and never fails the sync (marker preserved)", async () => {
    const warns: string[] = [];
    const connector = createSlackConnector(
      { channels: ["C1"] },
      { clientFactory: () => quietSlack(), conversationsTransport: throwingSweep, now: () => 0 },
    );
    // Sync still completes (no throw) and ingest is unaffected.
    const records = await drain(connector.sync(ctx({ onWarn: (m) => warns.push(m) })));
    expect(records).toEqual([]);
    expect(warns.some((w) => w.includes("discovery sweep skipped"))).toBe(true);
  });

  test("override skip: --no-discover suppresses the sweep even when config enables it", async () => {
    const { transport, calls } = fakeSweep({
      public_channel: [{ id: "C2", name: "random", is_member: true }],
    });
    const warns: string[] = [];
    // discover_new defaults to true, so config would normally sweep here.
    const connector = createSlackConnector(
      { channels: ["C1"] },
      { clientFactory: () => quietSlack(), conversationsTransport: transport, now: () => 0 },
    );
    await drain(connector.sync(ctx({ discover: "skip", onWarn: (m) => warns.push(m) })));
    expect(calls.length).toBe(0);
    expect(warns.some((w) => w.includes("new conversation(s)"))).toBe(false);
  });

  test("override force: --discover sweeps within the 24h cadence window", async () => {
    const { transport, calls } = fakeSweep({
      public_channel: [{ id: "C2", name: "random", is_member: true }],
    });
    const warns: string[] = [];
    // Prior sweep at t=0; now = 1h later → normally cadence-gated, but force wins.
    const prior = JSON.stringify({ default: { C1: "1.0" }, __discovery__: { default: "0:0" } });
    const connector = createSlackConnector(
      { channels: ["C1"] },
      { clientFactory: () => quietSlack(), conversationsTransport: transport, now: () => 1 * HOUR },
    );
    await drain(
      connector.sync(ctx({ cursor: prior, discover: "force", onWarn: (m) => warns.push(m) })),
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(warns.some((w) => w.includes("new conversation(s)"))).toBe(true);
    // The marker is refreshed with the forced-sweep time.
    const saved = (await connector.finalize?.())?.cursor ?? null;
    expect(readDiscoveryMarkers(saved)).toEqual([
      { alias: "default", lastSweptMs: 1 * HOUR, newCount: 1 },
    ]);
  });

  test("override force: --discover sweeps even when discover_new = false", async () => {
    const { transport, calls } = fakeSweep({
      public_channel: [{ id: "C2", name: "random", is_member: true }],
    });
    const warns: string[] = [];
    const connector = createSlackConnector(
      { channels: ["C1"], discover_new: false },
      { clientFactory: () => quietSlack(), conversationsTransport: transport, now: () => 0 },
    );
    await drain(connector.sync(ctx({ discover: "force", onWarn: (m) => warns.push(m) })));
    expect(calls.length).toBeGreaterThan(0);
    expect(warns.some((w) => w.includes("new conversation(s)"))).toBe(true);
  });

  test("override undefined: absent flag keeps the configured default (cadence-gated)", async () => {
    const { transport, calls } = fakeSweep({
      public_channel: [{ id: "C2", name: "random", is_member: true }],
    });
    // Prior sweep at t=0; now = 1h → within cadence, so the default path skips it.
    const prior = JSON.stringify({ default: { C1: "1.0" }, __discovery__: { default: "0:0" } });
    const connector = createSlackConnector(
      { channels: ["C1"] },
      { clientFactory: () => quietSlack(), conversationsTransport: transport, now: () => 1 * HOUR },
    );
    await drain(connector.sync(ctx({ cursor: prior, onWarn: () => {} })));
    expect(calls.length).toBe(0);
  });

  test("named workspace: the drift warn is scoped by alias", async () => {
    const { transport } = fakeSweep({
      public_channel: [{ id: "C2", name: "random", is_member: true }],
    });
    const warns: string[] = [];
    const connector = createSlackConnector(
      { workspaces: { acme: { team: "TA", channels: ["C1"] } } },
      { clientFactory: () => quietSlack(), conversationsTransport: transport, now: () => 0 },
    );
    await drain(
      connector.sync(
        ctx({
          secret: async (n) => (n === "acme:token" ? "xoxb" : null),
          onWarn: (m) => warns.push(m),
        }),
      ),
    );
    const driftWarn = warns.find((w) => w.includes("new conversation(s)"));
    expect(driftWarn).toContain("workspace 'acme':");
  });
});
