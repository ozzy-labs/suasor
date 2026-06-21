import { describe, expect, test } from "bun:test";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Config } from "../../src/config/index.ts";
import { McpToolError } from "../../src/mcp/errors.ts";
import {
  type ServeOptions,
  type ServeServer,
  type ServeStore,
  serveMcp,
} from "../../src/mcp/serve.ts";

/**
 * Direct tests for the stdio boot glue (`serveMcp`). All seams are faked — no
 * real config, store, MCP server, or stdio transport is touched (Issue #37).
 */

/**
 * A `Config` shaped just enough for `serveMcp` (dbPath + embedding + llm). The
 * `embedding.backend` / `llm.backend` overrides drive the config-warning check;
 * both default to a no-warning value.
 */
function fakeConfig(
  dbPath: string | null,
  overrides: { embeddingBackend?: string; llmBackend?: string } = {},
): Config {
  return {
    storage: { dbPath },
    embedding: { dim: 1024, backend: overrides.embeddingBackend ?? "disabled" },
    llm: { backend: overrides.llmBackend ?? "disabled" },
  } as unknown as Config;
}

/** A store seam that records whether it was opened and closed (count). */
function fakeStore(): ServeStore & { opened: boolean; closeCount: number } {
  const store = {
    opened: true,
    closeCount: 0,
    connection: { sqlite: {} as never },
    close() {
      store.closeCount += 1;
    },
  };
  return store;
}

/** A transport seam — `onclose` is wired by `serveMcp`; tests invoke it. */
function fakeTransport(): Transport {
  return {
    start: () => Promise.resolve(),
    send: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
}

/**
 * Assemble `ServeOptions` with all seams faked. `connect` controls the
 * `server.connect(transport)` outcome (resolve by default; reject to exercise
 * the cleanup path). Silences `log` so nothing reaches stdio.
 */
function options(args: {
  dbPath: string | null;
  store?: ServeStore;
  transport?: Transport;
  connect?: (transport: Transport) => Promise<void>;
  onOpen?: () => void;
  embeddingBackend?: string;
  llmBackend?: string;
}): ServeOptions {
  const connect = args.connect ?? (() => Promise.resolve());
  const server: ServeServer = { connect };
  return {
    log: () => {},
    loadConfig: () =>
      Promise.resolve(
        fakeConfig(args.dbPath, {
          embeddingBackend: args.embeddingBackend,
          llmBackend: args.llmBackend,
        }),
      ),
    openStore: () => {
      args.onOpen?.();
      return args.store ?? fakeStore();
    },
    buildServer: () => server,
    transport: args.transport,
  };
}

describe("serveMcp boot glue", () => {
  test("throws the documented error and opens no store when dbPath is null", async () => {
    let openedStore = false;
    await expect(
      serveMcp(options({ dbPath: null, onOpen: () => (openedStore = true) })),
    ).rejects.toThrow("storage.dbPath is not configured");
    // The guard runs before opening the store — no store handle is created.
    expect(openedStore).toBe(false);
  });

  test("readiness failure throws a structured CONFIG_INVALID error with a hint (ADR-0031)", async () => {
    const logs: string[] = [];
    let error: unknown;
    try {
      await serveMcp({
        ...options({ dbPath: null }),
        log: (m) => logs.push(m),
      });
    } catch (e) {
      error = e;
    }
    // The fatal mis-config surfaces as a structured McpToolError (code + hint),
    // not a bare Error, so the host can branch and show the fix.
    expect(error).toBeInstanceOf(McpToolError);
    const mcpError = error as McpToolError;
    expect(mcpError.code).toBe("CONFIG_INVALID");
    expect(mcpError.hint).toBeTruthy();
    // The issue + its hint are also written to the diagnostics channel (stderr).
    expect(logs.some((l) => l.includes("CONFIG_INVALID"))).toBe(true);
    expect(logs.some((l) => l.toLowerCase().includes("hint"))).toBe(true);
  });

  test("emits config warnings on stderr at boot for accepted-but-dropped keys (#235)", async () => {
    const logs: string[] = [];
    const transport = fakeTransport();
    const booted = serveMcp({
      ...options({
        dbPath: ":memory:",
        transport,
        embeddingBackend: "openai",
        llmBackend: "openai",
      }),
      log: (m) => logs.push(m),
    });
    await Promise.resolve();
    await Promise.resolve();
    transport.onclose?.();
    await booted;

    // Both silently-dropped keys are surfaced on the diagnostics channel.
    expect(logs.some((l) => l.includes("config warning") && l.includes("embedding.backend"))).toBe(
      true,
    );
    expect(logs.some((l) => l.includes("config warning") && l.includes("llm.backend"))).toBe(true);
  });

  test("emits no config warning when backends are implemented / inert (#235)", async () => {
    const logs: string[] = [];
    const transport = fakeTransport();
    const booted = serveMcp({
      ...options({
        dbPath: ":memory:",
        transport,
        embeddingBackend: "ollama",
        llmBackend: "disabled",
      }),
      log: (m) => logs.push(m),
    });
    await Promise.resolve();
    await Promise.resolve();
    transport.onclose?.();
    await booted;

    expect(logs.some((l) => l.includes("config warning"))).toBe(false);
  });

  test("transport.onclose closes the store exactly once (idempotent close)", async () => {
    const store = fakeStore();
    const transport = fakeTransport();
    // connect resolves; the boot promise settles only when onclose fires.
    const booted = serveMcp(options({ dbPath: ":memory:", store, transport }));

    // Let connect() settle so onclose is wired and the success log runs.
    await Promise.resolve();
    await Promise.resolve();

    // Host disconnects, then a stray second close arrives (e.g. close() also
    // invokes onclose). The `closed` flag must collapse both to one store close.
    transport.onclose?.();
    transport.onclose?.();

    await booted; // resolves via the first onclose
    expect(store.closeCount).toBe(1);
  });

  test("a server.connect rejection rejects serveMcp AND closes the store", async () => {
    const store = fakeStore();
    const boom = new Error("connect failed: transport unavailable");
    await expect(
      serveMcp(
        options({
          dbPath: ":memory:",
          store,
          transport: fakeTransport(),
          connect: () => Promise.reject(boom),
        }),
      ),
    ).rejects.toThrow("connect failed: transport unavailable");
    // The rejection path runs the cleanup: the store is closed exactly once.
    expect(store.closeCount).toBe(1);
  });

  test("a connect rejection after a close does not double-close the store", async () => {
    // Edge case: onclose fires (store closed once) before a late connect
    // rejection. The `closed` flag must prevent a second close().
    const store = fakeStore();
    const transport = fakeTransport();
    let rejectConnect: ((err: Error) => void) | undefined;
    const booted = serveMcp(
      options({
        dbPath: ":memory:",
        store,
        transport,
        connect: () =>
          new Promise<void>((_resolve, reject) => {
            rejectConnect = reject;
          }),
      }),
    );

    await Promise.resolve();
    // Host disconnects first → store closed via onclose, boot promise resolves.
    transport.onclose?.();
    await booted;
    expect(store.closeCount).toBe(1);

    // A late connect rejection must not close the store a second time.
    rejectConnect?.(new Error("late failure"));
    await Promise.resolve();
    expect(store.closeCount).toBe(1);
  });
});
