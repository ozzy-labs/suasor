/**
 * `suasor source list` / `suasor source forget` — CLI surface for local data
 * audit + manual purge (Issue #200). Verifies list filters / --json, the forget
 * HITL preview vs --yes apply, the unknown-id error, and that --yes actually
 * redacts the event-log body + purges the projection (ADR-0026).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCli } from "../../src/cli/index.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "suasor-cli-source-"));
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

/** Seed the db the CLI will open (default path under SUASOR_CONFIG_DIR). */
async function seed(
  externalId: string,
  body: string,
  opts: { sourceType?: string; observedAt?: string } = {},
): Promise<void> {
  const { Store } = await import("../../src/db/index.ts");
  const store = Store.open({ path: join(dir, "suasor.db") });
  store.record({
    type: "SourceObserved",
    externalId,
    sourceType: opts.sourceType ?? "github_issue",
    body,
    observedAt: opts.observedAt ?? "2026-06-14T00:00:00.000Z",
    fingerprint: externalId,
    meta: {},
  });
  store.close();
}

/** Read the event-log bodies for an id (to assert redaction). */
async function eventBodies(externalId: string): Promise<string[]> {
  const { Store } = await import("../../src/db/index.ts");
  const store = Store.open({ path: join(dir, "suasor.db") });
  try {
    return store.connection.sqlite
      .query<{ b: string }, [string]>(
        `SELECT json_extract(payload, '$.body') AS b FROM events
            WHERE type IN ('SourceObserved','SourceBodyUpdated')
              AND json_extract(payload, '$.externalId') = ?`,
      )
      .all(externalId)
      .map((r) => r.b);
  } finally {
    store.close();
  }
}

describe("suasor source list", () => {
  test("lists ingested sources newest-first", async () => {
    await seed("gh:1", "first", { observedAt: "2026-06-10T00:00:00.000Z" });
    await seed("gh:2", "second", { observedAt: "2026-06-12T00:00:00.000Z" });
    const { code, out } = await run(["source", "list"]);
    expect(code).toBe(0);
    expect(out).toContain("2 source(s):");
    // Newest first.
    expect(out.indexOf("gh:2")).toBeLessThan(out.indexOf("gh:1"));
  });

  test("never prints the source body (NFR-PRV-4)", async () => {
    await seed("gh:1", "secret rocket plans");
    const { out } = await run(["source", "list"]);
    expect(out).not.toContain("secret rocket plans");
  });

  test("--type filters by source_type", async () => {
    await seed("gh:1", "issue", { sourceType: "github_issue" });
    await seed("sl:1", "msg", { sourceType: "slack_message" });
    const { code, out } = await run(["source", "list", "--type", "slack_message"]);
    expect(code).toBe(0);
    expect(out).toContain("1 source(s):");
    expect(out).toContain("sl:1");
    expect(out).not.toContain("gh:1");
  });

  test("--since / --until window over observed_at", async () => {
    await seed("gh:old", "old", { observedAt: "2026-05-01T00:00:00.000Z" });
    await seed("gh:new", "new", { observedAt: "2026-06-15T00:00:00.000Z" });
    const { code, out } = await run([
      "source",
      "list",
      "--since",
      "2026-06-01T00:00:00Z",
      "--until",
      "2026-07-01T00:00:00Z",
    ]);
    expect(code).toBe(0);
    expect(out).toContain("gh:new");
    expect(out).not.toContain("gh:old");
  });

  test("--json emits {externalId, sourceType, observedAt}[] without bodies", async () => {
    await seed("gh:1", "secret rocket plans");
    const { code, out } = await run(["source", "list", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].externalId).toBe("gh:1");
    expect(parsed[0].sourceType).toBe("github_issue");
    expect(parsed[0].observedAt).toBe("2026-06-14T00:00:00.000Z");
    expect(parsed[0].body).toBeUndefined();
    expect(out).not.toContain("secret rocket plans");
  });

  test("--limit rejects a non-positive value", async () => {
    await seed("gh:1", "x");
    const { code, err } = await run(["source", "list", "--limit", "0"]);
    expect(code).toBe(1);
    expect(err).toContain("--limit must be a positive integer");
  });

  test("prints a clear message when there are no sources", async () => {
    await seed("gh:1", "x");
    const { code, out } = await run(["source", "list", "--type", "no_such_type"]);
    expect(code).toBe(0);
    expect(out).toContain("No sources.");
  });
});

describe("suasor source forget", () => {
  test("without --yes previews only and applies nothing", async () => {
    await seed("gh:1", "secret rocket plans");
    const { code, out } = await run(["source", "forget", "gh:1"]);
    expect(code).toBe(0);
    expect(out).toContain("would forget: gh:1");
    expect(out).toContain("(preview — re-run with --yes to apply)");
    // The body is untouched (no apply).
    expect(await eventBodies("gh:1")).toEqual(["secret rocket plans"]);
  });

  test("never prints the source body in the preview (NFR-PRV-4)", async () => {
    await seed("gh:1", "secret rocket plans");
    const { out } = await run(["source", "forget", "gh:1"]);
    expect(out).not.toContain("secret rocket plans");
  });

  test("--yes redacts the event body and purges the projection (ADR-0026)", async () => {
    await seed("gh:1", "secret rocket plans");
    const { code, out } = await run(["source", "forget", "gh:1", "--yes"]);
    expect(code).toBe(0);
    expect(out).toContain("forgotten: gh:1");
    // Event-log body redacted; projection row gone.
    expect(await eventBodies("gh:1")).toEqual([""]);
    const list = await run(["source", "list", "--json"]);
    expect(JSON.parse(list.out)).toHaveLength(0);
  });

  test("--reason is recorded on the audit event", async () => {
    await seed("gh:1", "x");
    const { code } = await run(["source", "forget", "gh:1", "--reason", "GDPR request", "--yes"]);
    expect(code).toBe(0);
    const { Store } = await import("../../src/db/index.ts");
    const store = Store.open({ path: join(dir, "suasor.db") });
    try {
      const rows = store.connection.sqlite
        .query("SELECT payload FROM events WHERE type = 'SourceForgotten'")
        .all() as { payload: string }[];
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0]?.payload ?? "{}").reason).toBe("GDPR request");
    } finally {
      store.close();
    }
  });

  test("an unknown id errors (preview path)", async () => {
    await seed("gh:1", "x");
    const { code, err } = await run(["source", "forget", "gh:nope"]);
    expect(code).toBe(1);
    expect(err).toContain("no source with external id 'gh:nope'");
  });

  test("an unknown id errors with --yes (missing)", async () => {
    await seed("gh:1", "x");
    const { code, err } = await run(["source", "forget", "gh:nope", "--yes"]);
    expect(code).toBe(1);
    expect(err).toContain("no source with external id 'gh:nope'");
  });

  test("re-forgetting reports already forgotten (idempotent)", async () => {
    await seed("gh:1", "x");
    await run(["source", "forget", "gh:1", "--yes"]);
    const { code, out } = await run(["source", "forget", "gh:1", "--yes"]);
    expect(code).toBe(0);
    expect(out).toContain("already forgotten: gh:1");
  });
});
