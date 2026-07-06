import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCli } from "../../src/cli/index.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "suasor-cli-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Run the CLI capturing stdout/stderr; uses SUASOR_CONFIG_DIR for isolation. */
async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const prev = process.env.SUASOR_CONFIG_DIR;
  process.env.SUASOR_CONFIG_DIR = dir;
  let out = "";
  let err = "";
  const cli = buildCli();
  try {
    const code = await cli.run(args, {
      stdin: process.stdin,
      stdout: {
        write: (s: string) => {
          out += s;
          return true;
        },
      } as NodeJS.WriteStream,
      stderr: {
        write: (s: string) => {
          err += s;
          return true;
        },
      } as NodeJS.WriteStream,
      env: process.env,
      colorDepth: 1,
    });
    return { code, out, err };
  } finally {
    if (prev === undefined) delete process.env.SUASOR_CONFIG_DIR;
    else process.env.SUASOR_CONFIG_DIR = prev;
  }
}

describe("suasor projections rebuild", () => {
  test("rebuilds against a fresh db (0 events) and exits 0", async () => {
    const { code, out } = await run(["projections", "rebuild"]);
    expect(code).toBe(0);
    expect(out).toContain("Rebuilt projections from 0 event(s).");
  });

  test("reports the replayed event count after appends", async () => {
    // Seed the same db the CLI will open.
    const { Store } = await import("../../src/db/index.ts");
    const dbPath = join(dir, "suasor.db");
    const store = Store.open({ path: dbPath });
    store.record({
      type: "SourceObserved",
      externalId: "gh:1",
      sourceType: "github_issue",
      body: "hello",
      observedAt: "2026-06-14T00:00:00.000Z",
      fingerprint: "fp1",
      meta: {},
    });
    store.close();

    const { code, out } = await run(["projections", "rebuild"]);
    expect(code).toBe(0);
    expect(out).toContain("Rebuilt projections from 1 event(s).");
  });

  test("--no-progress is accepted and keeps stdout clean (no ANSI)", async () => {
    const { code, out } = await run(["projections", "rebuild", "--no-progress"]);
    expect(code).toBe(0);
    expect(out).toContain("Rebuilt projections from 0 event(s).");
    // The summary line is the only stdout content — no progress escapes leak in.
    expect(out).not.toContain("\x1b");
    expect(out).not.toContain("processed");
  });

  // ADR-0005 §5 / Issue #414: rebuild clears the non-replayable embedding sidecar,
  // so when vectors were present it must warn that recall is empty until drain.
  test("prints a drain reminder when embedding vectors were cleared (#414)", async () => {
    const [{ Store, DEFAULT_EMBEDDING_DIM }, { upsertSourceVector }] = await Promise.all([
      import("../../src/db/index.ts"),
      import("../../src/retrieval/embedding/recall.ts"),
    ]);
    const dbPath = join(dir, "suasor.db");
    const store = Store.open({ path: dbPath });
    store.record({
      type: "SourceObserved",
      externalId: "gh:1",
      sourceType: "github_issue",
      body: "embed me",
      observedAt: "2026-06-14T00:00:00.000Z",
      fingerprint: "fp1",
      meta: {},
    });
    upsertSourceVector(
      store.connection.sqlite,
      "gh:1",
      new Array(DEFAULT_EMBEDDING_DIM).fill(0.1),
      {
        modelId: "bge-m3",
        modelVersion: "1",
      },
    );
    store.close();

    const { code, out } = await run(["projections", "rebuild"]);
    expect(code).toBe(0);
    expect(out).toContain("Rebuilt projections from 1 event(s).");
    expect(out).toContain("1 embedding vector(s) cleared");
    expect(out).toContain("suasor embeddings drain");
  });

  test("no drain reminder when nothing was embedded (#414)", async () => {
    const { Store } = await import("../../src/db/index.ts");
    const dbPath = join(dir, "suasor.db");
    const store = Store.open({ path: dbPath });
    store.record({
      type: "SourceObserved",
      externalId: "gh:1",
      sourceType: "github_issue",
      body: "no vector",
      observedAt: "2026-06-14T00:00:00.000Z",
      fingerprint: "fp1",
      meta: {},
    });
    store.close();

    const { code, out } = await run(["projections", "rebuild"]);
    expect(code).toBe(0);
    expect(out).toContain("Rebuilt projections from 1 event(s).");
    expect(out).not.toContain("embeddings drain");
  });
});
