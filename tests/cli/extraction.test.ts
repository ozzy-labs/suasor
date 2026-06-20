/**
 * `suasor extraction status` / `extraction list-pending` CLI wiring (ADR-0024,
 * Issue #202). Seeds local_file sources + extraction_meta directly, then asserts
 * the status roll-up and the pending/stale drilldown.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCli } from "../../src/cli/index.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "suasor-cli-extraction-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

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

/** Seed a local_file source (extractable filename in meta.name). */
async function seedFile(externalId: string, filename: string): Promise<void> {
  const { Store } = await import("../../src/db/index.ts");
  const store = Store.open({ path: join(dir, "suasor.db") });
  store.record({
    type: "SourceObserved",
    externalId,
    sourceType: "local_file",
    body: filename,
    observedAt: "2026-06-14T00:00:00.000Z",
    fingerprint: externalId,
    meta: { name: filename },
  });
  store.close();
}

/** Insert an extraction_meta row directly (records a prior extraction attempt). */
async function seedMeta(externalId: string, version: string): Promise<void> {
  const { Store } = await import("../../src/db/index.ts");
  const store = Store.open({ path: join(dir, "suasor.db") });
  store.connection.sqlite
    .query(
      "INSERT INTO extraction_meta (external_id, version, state, updated_at) VALUES (?, ?, 'extracted', ?)",
    )
    .run(externalId, version, "2026-06-14T00:00:00.000Z");
  store.close();
}

describe("suasor extraction list-pending (Issue #202)", () => {
  test("lists pending (never attempted) and stale (version drift) sources", async () => {
    await run(["init"]);
    await Bun.write(
      join(dir, "config.toml"),
      '[extraction]\nbackend = "markitdown"\nversion = "2"\n',
    );
    await seedFile("doc:1", "a.docx"); // never attempted → pending
    await seedFile("doc:2", "b.pdf");
    await seedMeta("doc:2", "1"); // recorded v1, current v2 → stale

    const { code, out } = await run(["extraction", "list-pending"]);
    expect(code).toBe(0);
    expect(out).toContain("2 source(s) awaiting (re)extraction");
    expect(out).toContain("[pending] a.docx  doc:1");
    expect(out).toContain("[stale] b.pdf  doc:2");
    expect(out).toContain("local sync");
  });

  test("--json emits the pending-source list", async () => {
    await run(["init"]);
    await Bun.write(
      join(dir, "config.toml"),
      '[extraction]\nbackend = "markitdown"\nversion = "1"\n',
    );
    await seedFile("doc:1", "a.docx");
    const { code, out } = await run(["extraction", "list-pending", "--json"]);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual([{ externalId: "doc:1", name: "a.docx", reason: "pending" }]);
  });

  test("--limit caps the listing", async () => {
    await run(["init"]);
    await seedFile("doc:1", "a.docx");
    await seedFile("doc:2", "b.pdf");
    const { code, out } = await run(["extraction", "list-pending", "--limit", "1", "--json"]);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toHaveLength(1);
  });

  test("rejects a non-positive --limit", async () => {
    await run(["init"]);
    const { code, err } = await run(["extraction", "list-pending", "--limit", "0"]);
    expect(code).toBe(1);
    expect(err).toContain("--limit must be a positive integer");
  });

  test("a settled store reports nothing awaiting", async () => {
    await run(["init"]);
    const { code, out } = await run(["extraction", "list-pending"]);
    expect(code).toBe(0);
    expect(out).toContain("No sources awaiting (re)extraction.");
  });
});
