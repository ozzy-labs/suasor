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

/** Seed a source into the same db the CLI will open (default <dir>/suasor.db). */
async function seed(externalId: string, body: string): Promise<void> {
  const { Store } = await import("../../src/db/index.ts");
  const store = Store.open({ path: join(dir, "suasor.db") });
  store.record({
    type: "SourceObserved",
    externalId,
    sourceType: "github_issue",
    body,
    observedAt: "2026-06-14T00:00:00.000Z",
    fingerprint: externalId,
    meta: {},
  });
  store.close();
}

/** Insert an `extraction_meta` row directly to simulate version drift. */
async function seedExtractionMeta(externalId: string, version: string): Promise<void> {
  const { Store } = await import("../../src/db/index.ts");
  const store = Store.open({ path: join(dir, "suasor.db") });
  store.connection.sqlite
    .query(
      "INSERT INTO extraction_meta (external_id, version, state, updated_at) VALUES (?, ?, 'extracted', ?)",
    )
    .run(externalId, version, "2026-06-14T00:00:00.000Z");
  store.close();
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
    expect(out).toContain("11 projection tables");
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

  // Issue #202: maintenance hints surface drainable backlogs from the derived
  // substrates. They appear only when the backend is enabled AND there is a
  // backlog — a settled or disabled store stays quiet.
  test("pending embeddings emit a maintenance hint when the backend is enabled (#202)", async () => {
    await run(["init"]);
    await writeConfig('[embedding]\nbackend = "ollama"\nmodel = "bge-m3"\n');
    await seed("gh:1", "alpha"); // no vector → pending
    const { out } = await run(["doctor", "--json"]);
    const report = JSON.parse(out) as DoctorReport;
    const hint = report.checks.find((c) => c.name === "maintenance" && c.status === "warn");
    expect(hint?.detail).toContain("pending embeddings: 1");
    expect(hint?.detail).toContain("embeddings drain");
  });

  test("no maintenance hint when the embedding backend is disabled (#202)", async () => {
    await run(["init"]); // default: embedding backend disabled
    await seed("gh:1", "alpha");
    const { out } = await run(["doctor", "--json"]);
    const report = JSON.parse(out) as DoctorReport;
    expect(report.checks.some((c) => c.name === "maintenance")).toBe(false);
  });

  test("extraction version drift emits a maintenance hint (#202)", async () => {
    await run(["init"]);
    await writeConfig('[extraction]\nbackend = "markitdown"\nversion = "2"\n');
    await seedExtractionMeta("doc:1", "1"); // recorded v1, current v2 → stale
    const { out } = await run(["doctor", "--json"]);
    const report = JSON.parse(out) as DoctorReport;
    const hint = report.checks.find(
      (c) => c.name === "maintenance" && c.detail.includes("version drift"),
    );
    expect(hint?.status).toBe("warn");
    expect(hint?.detail).toContain("local sync");
  });

  test("unimplemented embedding backend (openai) is a config warning (#235)", async () => {
    await run(["init"]);
    await writeConfig('[embedding]\nbackend = "openai"\n');
    const { out } = await run(["doctor", "--json"]);
    const report = JSON.parse(out) as DoctorReport;
    const warn = report.checks.find((c) => c.name === "embedding.backend");
    expect(warn?.status).toBe("warn");
    expect(warn?.detail).toContain("openai");
    expect(warn?.detail).toContain("FTS");
  });

  test("set-but-unused [llm] backend is a config warning (#235)", async () => {
    await run(["init"]);
    await writeConfig('[llm]\nbackend = "anthropic"\n');
    const { out } = await run(["doctor", "--json"]);
    const report = JSON.parse(out) as DoctorReport;
    const warn = report.checks.find((c) => c.name === "llm.backend");
    expect(warn?.status).toBe("warn");
    expect(warn?.detail).toContain("anthropic");
  });

  // Issue #267: doctor probes the model's actual output dimension once and
  // compares it to [embedding].dim (which sizes vec0). A mismatch is an error
  // (vector inserts would fail → recall silently empty); a match is ok.
  test("dimension mismatch (dim ≠ model output) is an error (#267)", async () => {
    await run(["init"]);
    // Local ollama-style sidecar returning 2-dim vectors while dim=4 is set.
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(JSON.stringify({ embeddings: [[1, 2]] }), {
          headers: { "content-type": "application/json" },
        }),
    });
    try {
      await writeConfig(
        `[embedding]\nbackend = "ollama"\nmodel = "bge-m3"\ndim = 4\nbaseUrl = "http://localhost:${server.port}"\n`,
      );
      const { code, out } = await run(["doctor", "--json"]);
      expect(code).toBe(1); // error fails the exit code
      const report = JSON.parse(out) as DoctorReport;
      const dim = report.checks.find((c) => c.name === "embedding.dim");
      expect(dim?.status).toBe("error");
      expect(dim?.detail).toContain("2-dim");
      expect(dim?.detail).toContain("[embedding].dim is 4");
    } finally {
      server.stop(true);
    }
  });

  test("matching dimension (dim == model output) is ok (#267)", async () => {
    await run(["init"]);
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(JSON.stringify({ embeddings: [[1, 2, 3]] }), {
          headers: { "content-type": "application/json" },
        }),
    });
    try {
      await writeConfig(
        `[embedding]\nbackend = "ollama"\nmodel = "bge-m3"\ndim = 3\nbaseUrl = "http://localhost:${server.port}"\n`,
      );
      const { code, out } = await run(["doctor", "--json"]);
      expect(code).toBe(0);
      const report = JSON.parse(out) as DoctorReport;
      const dim = report.checks.find((c) => c.name === "embedding.dim");
      expect(dim?.status).toBe("ok");
    } finally {
      server.stop(true);
    }
  });

  test("dim probe failure (unreachable sidecar) is a warning, not an error (#267)", async () => {
    await run(["init"]);
    // Port 1 is unbound → connection refused → probe fails fast (warn).
    await writeConfig(
      '[embedding]\nbackend = "ollama"\nmodel = "bge-m3"\ndim = 1024\nbaseUrl = "http://localhost:1"\n',
    );
    const { out } = await run(["doctor", "--json"]);
    const report = JSON.parse(out) as DoctorReport;
    const dim = report.checks.find((c) => c.name === "embedding.dim");
    expect(dim?.status).toBe("warn");
    expect(dim?.detail).toContain("could not probe");
  });

  test("implemented / inert backends emit no config warning (#235)", async () => {
    await run(["init"]);
    await writeConfig(
      '[embedding]\nbackend = "ollama"\nmodel = "bge-m3"\n[llm]\nbackend = "disabled"\n',
    );
    const { out } = await run(["doctor", "--json"]);
    const report = JSON.parse(out) as DoctorReport;
    expect(report.checks.some((c) => c.name === "embedding.backend")).toBe(false);
    expect(report.checks.some((c) => c.name === "llm.backend")).toBe(false);
  });
});
