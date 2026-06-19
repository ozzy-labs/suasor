import { describe, expect, test } from "bun:test";
import { buildCli } from "../../src/cli/index.ts";

/** Run the CLI capturing stdout/stderr (Slack token env cleared for isolation). */
async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const prev = process.env.SUASOR_CONNECTOR_SLACK_TOKEN;
  delete process.env.SUASOR_CONNECTOR_SLACK_TOKEN;
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
    if (prev === undefined) delete process.env.SUASOR_CONNECTOR_SLACK_TOKEN;
    else process.env.SUASOR_CONNECTOR_SLACK_TOKEN = prev;
  }
}

describe("suasor slack — wiring + arg validation (no network)", () => {
  test("the slack verbs are registered in --help", async () => {
    const { code, out } = await run(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("slack auth");
    expect(out).toContain("slack conversations");
  });

  test("auth test without a configured token exits 1 with guidance", async () => {
    const { code, err } = await run(["slack", "auth", "test"]);
    expect(code).toBe(1);
    expect(err).toContain("no Slack token configured");
  });

  test("conversations rejects an invalid --types before any token lookup", async () => {
    const { code, err } = await run(["slack", "conversations", "--types", "bogus"]);
    expect(code).toBe(1);
    expect(err).toContain("invalid --types");
  });

  test("conversations rejects a non-positive --limit", async () => {
    const { code, err } = await run(["slack", "conversations", "--limit", "0"]);
    expect(code).toBe(1);
    expect(err).toContain("--limit must be a positive integer");
  });

  test("conversations without a configured token exits 1 with guidance", async () => {
    const { code, err } = await run(["slack", "conversations"]);
    expect(code).toBe(1);
    expect(err).toContain("no Slack token configured");
  });

  test("--workspace flows into the no-token guidance (ADR-0014)", async () => {
    const { code, err } = await run(["slack", "auth", "test", "--workspace", "acme"]);
    expect(code).toBe(1);
    expect(err).toContain("auth set --workspace acme");
  });

  test("conversations rejects an invalid --sort before any token lookup (ADR-0013)", async () => {
    const { code, err } = await run(["slack", "conversations", "--sort", "bogus"]);
    expect(code).toBe(1);
    expect(err).toContain("invalid --sort");
  });

  test("conversations --no-progress is accepted and arg validation still runs first (#84)", async () => {
    // --no-progress is a registered flag; bad --types still fails fast before any
    // token / network / progress work.
    const { code, err } = await run([
      "slack",
      "conversations",
      "--no-progress",
      "--types",
      "bogus",
    ]);
    expect(code).toBe(1);
    expect(err).toContain("invalid --types");
  });
});
