/**
 * `suasor doctor` CLI wiring (aggregate health check, docs/design/cli.md).
 * Runs end-to-end against a temp config dir. Connector credential presence is
 * driven through the env override (`SUASOR_CONNECTOR_<NAME>_<SECRET>`) so the
 * test never touches the OS keychain.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCli } from "../../src/cli/index.ts";

let dir: string;

const SECRET_ENVS = [
  "SUASOR_CONNECTOR_GITHUB_TOKEN",
  "SUASOR_CONNECTOR_SLACK_TOKEN",
  "SUASOR_CONNECTOR_MS_GRAPH_CLIENTSECRET",
  "SUASOR_CONNECTOR_GOOGLE_REFRESHTOKEN",
  "SUASOR_CONNECTOR_BOX_TOKEN",
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "suasor-cli-doctor-"));
  for (const name of SECRET_ENVS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const name of SECRET_ENVS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
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

async function writeConfig(toml: string): Promise<void> {
  await Bun.write(join(dir, "config.toml"), toml);
}

type DoctorReport = { ok: boolean; checks: { name: string; status: string; detail: string }[] };

describe("suasor doctor", () => {
  test("--help lists the doctor command", async () => {
    const { code, out } = await run(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("doctor");
  });

  test("fresh dir: config warn + database error, exits 1", async () => {
    const { code, out } = await run(["doctor"]);
    expect(code).toBe(1);
    expect(out).toContain("[WARN] config");
    expect(out).toContain("[ERR ] database");
    expect(out).toContain("1 error(s)");
  });

  test("after init: all green, exits 0", async () => {
    await run(["init"]);
    const { code, out } = await run(["doctor"]);
    expect(code).toBe(0);
    expect(out).toContain("[OK  ] config");
    expect(out).toContain("[OK  ] database");
    expect(out).toContain("10 projection tables");
    expect(out).toContain("0 error(s)");
  });

  test("--json fresh reports ok=false with a database error check", async () => {
    const { code, out } = await run(["doctor", "--json"]);
    expect(code).toBe(1);
    const report = JSON.parse(out) as DoctorReport;
    expect(report.ok).toBe(false);
    const db = report.checks.find((c) => c.name === "database");
    expect(db?.status).toBe("error");
  });

  test("--json after init reports ok=true", async () => {
    await run(["init"]);
    const { code, out } = await run(["doctor", "--json"]);
    expect(code).toBe(0);
    const report = JSON.parse(out) as DoctorReport;
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.name)).toEqual([
      "config",
      "database",
      "embedding",
      "extraction",
      "connectors",
    ]);
  });

  test("enabled connector with a missing credential is a warning", async () => {
    await run(["init"]);
    await writeConfig(["[connectors.github]", "repos = []", "", "[connectors.slack]"].join("\n"));
    const { code, out } = await run(["doctor", "--json"]);
    // Connector creds missing is a warning, not an error → still exits 0.
    expect(code).toBe(0);
    const report = JSON.parse(out) as DoctorReport;
    const connectors = report.checks.find((c) => c.name === "connectors");
    expect(connectors?.status).toBe("warn");
    expect(connectors?.detail).toContain("github");
    expect(connectors?.detail).toContain("slack");
  });

  test("enabled connector with its credential set is ok", async () => {
    await run(["init"]);
    await writeConfig("[connectors.github]\nrepos = []\n");
    process.env.SUASOR_CONNECTOR_GITHUB_TOKEN = "ghp_test";
    const { code, out } = await run(["doctor", "--json"]);
    expect(code).toBe(0);
    const report = JSON.parse(out) as DoctorReport;
    const connectors = report.checks.find((c) => c.name === "connectors");
    expect(connectors?.status).toBe("ok");
    expect(connectors?.detail).toContain("1 enabled");
  });

  test("credential stored but connector not enabled is a warning (#161)", async () => {
    await run(["init"]);
    // No [connectors.*] section at all → "no connectors enabled" info, but a
    // token is already in the keychain (here the env override). Doctor must
    // surface it rather than only saying nothing is enabled.
    process.env.SUASOR_CONNECTOR_GITHUB_TOKEN = "ghp_test";
    const { code, out } = await run(["doctor", "--json"]);
    expect(code).toBe(0); // stored-but-not-enabled is warn, not error.
    const report = JSON.parse(out) as DoctorReport;
    const connectorChecks = report.checks.filter((c) => c.name === "connectors");
    // The plain "no connectors enabled" info is still present...
    expect(connectorChecks.some((c) => c.status === "info")).toBe(true);
    // ...plus a warning naming the connector with the dangling credential.
    const stored = connectorChecks.find((c) => c.status === "warn");
    expect(stored).toBeDefined();
    expect(stored?.detail).toContain("github");
    expect(stored?.detail).toContain("not enabled");
    // Secret value is never disclosed (NFR-PRV-4).
    expect(stored?.detail).not.toContain("ghp_test");
  });

  test("explicitly disabled connector with a stored credential is a warning (#161)", async () => {
    await run(["init"]);
    await writeConfig("[connectors.github]\nenabled = false\nrepos = []\n");
    process.env.SUASOR_CONNECTOR_GITHUB_TOKEN = "ghp_test";
    const { code, out } = await run(["doctor", "--json"]);
    expect(code).toBe(0);
    const report = JSON.parse(out) as DoctorReport;
    const stored = report.checks.find((c) => c.name === "connectors" && c.status === "warn");
    expect(stored?.detail).toContain("github");
    expect(stored?.detail).toContain("not enabled");
  });

  test("enabled connector with a credential emits no stored-but-not-enabled warning (#161)", async () => {
    await run(["init"]);
    await writeConfig("[connectors.github]\nrepos = []\n");
    process.env.SUASOR_CONNECTOR_GITHUB_TOKEN = "ghp_test";
    const { out } = await run(["doctor", "--json"]);
    const report = JSON.parse(out) as DoctorReport;
    const connectorChecks = report.checks.filter((c) => c.name === "connectors");
    // Exactly one connectors check (the ok line) — no spurious "not enabled".
    expect(connectorChecks).toHaveLength(1);
    expect(connectorChecks[0]?.status).toBe("ok");
    expect(connectorChecks.some((c) => c.detail.includes("not enabled"))).toBe(false);
  });

  test("no stored credentials and nothing enabled: plain info only (#161)", async () => {
    await run(["init"]);
    const { out } = await run(["doctor", "--json"]);
    const report = JSON.parse(out) as DoctorReport;
    const connectorChecks = report.checks.filter((c) => c.name === "connectors");
    expect(connectorChecks).toHaveLength(1);
    expect(connectorChecks[0]?.status).toBe("info");
  });
});
