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
  "SUASOR_CONNECTOR_SLACK_ACME_TOKEN",
  "SUASOR_CONNECTOR_SLACK_BP_TOKEN",
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

/**
 * Persist a Slack resume cursor (a `ConnectorSyncCompleted` event) so the doctor
 * discovery-drift check (ADR-0039 Layer 2) can read the drift marker offline.
 */
async function seedSlackCursor(cursor: string): Promise<void> {
  const { Store } = await import("../../src/db/index.ts");
  const store = Store.open({ path: join(dir, "suasor.db") });
  store.record({ type: "ConnectorSyncCompleted", connector: "slack", cursor, count: 0 });
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

/**
 * Insert an `embeddings_meta` row with no matching vec0 vector — the exact
 * divergence a pre-fix `projections rebuild` left behind (meta kept, vector
 * cleared). doctor must flag this as an error (ADR-0005 §5, #414).
 */
async function seedOrphanEmbeddingMeta(externalId: string): Promise<void> {
  const { Store } = await import("../../src/db/index.ts");
  const store = Store.open({ path: join(dir, "suasor.db") });
  store.connection.sqlite
    .query(
      "INSERT INTO embeddings_meta (external_id, model_id, model_version, embedded_at) VALUES (?, 'bge-m3', '1', ?)",
    )
    .run(externalId, "2026-06-14T00:00:00.000Z");
  store.close();
}

/** Seed a source WITH a matching vec0 vector + embeddings_meta row (healthy). */
async function seedEmbeddedSource(externalId: string): Promise<void> {
  const [{ Store, DEFAULT_EMBEDDING_DIM }, { upsertSourceVector }] = await Promise.all([
    import("../../src/db/index.ts"),
    import("../../src/retrieval/embedding/recall.ts"),
  ]);
  const store = Store.open({ path: join(dir, "suasor.db") });
  store.record({
    type: "SourceObserved",
    externalId,
    sourceType: "github_issue",
    body: "embedded",
    observedAt: "2026-06-14T00:00:00.000Z",
    fingerprint: externalId,
    meta: {},
  });
  upsertSourceVector(
    store.connection.sqlite,
    externalId,
    new Array(DEFAULT_EMBEDDING_DIM).fill(0.1),
    {
      modelId: "bge-m3",
      modelVersion: "1",
    },
  );
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
    expect(out).toContain("13 projection tables");
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
      "store.growth",
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

  // ADR-0005 §5 / Issue #414: vec0 (vectors) and embeddings_meta (provenance) are
  // written and cleared together, so a row-count divergence is silent corruption
  // (recall returns empty while status claims coverage). doctor flags it as an
  // error — regardless of the active backend — so the mismatch can never hide.
  test("vec0 ↔ embeddings_meta divergence is an error (ADR-0005 §5, #414)", async () => {
    await run(["init"]);
    await seed("gh:1", "alpha");
    await seedOrphanEmbeddingMeta("gh:1"); // meta row, no vec0 vector → divergence
    const { code, out } = await run(["doctor", "--json"]);
    expect(code).toBe(1); // an error fails the exit code (cron / CI gate)
    const report = JSON.parse(out) as DoctorReport;
    const sub = report.checks.find((c) => c.name === "embedding.substrate");
    expect(sub?.status).toBe("error");
    expect(sub?.detail).toContain("vec0 has 0 vector(s)");
    expect(sub?.detail).toContain("embeddings_meta has 1 provenance row(s)");
    expect(sub?.detail).toContain("embeddings drain");
  });

  test("matched vec0 / embeddings_meta counts stay quiet (ADR-0005 §5, #414)", async () => {
    await run(["init"]);
    await seedEmbeddedSource("gh:1"); // vec0 = 1, embeddings_meta = 1 → aligned
    const { code, out } = await run(["doctor", "--json"]);
    expect(code).toBe(0);
    const report = JSON.parse(out) as DoctorReport;
    expect(report.checks.some((c) => c.name === "embedding.substrate")).toBe(false);
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

  // ADR-0038 Layer 3: doctor detects a Slack channel id listed under more than
  // one workspace alias and warns which owner will ingest it (early detection,
  // without running a sync). The owner rule (lexicographically smallest alias)
  // is shared with sync via `channelOwnership`.
  test("a legacy multi-workspace config is a slack.config error (ADR-0042 決定 9)", async () => {
    await run(["init"]);
    await writeConfig(
      [
        "[connectors.slack.workspaces.employees]",
        'team = "T_EMP"',
        'channels = ["C123", "C_EMP_ONLY"]',
        "",
        "[connectors.slack.workspaces.bp]",
        'team = "T_BP"',
        'channels = ["C123", "C_BP_ONLY"]',
      ].join("\n"),
    );
    const { code, out } = await run(["doctor", "--json"]);
    // The loader itself rejects the legacy shape, so doctor surfaces it as the
    // config-load error carrying the mechanical migration message.
    expect(code).toBe(1);
    const report = JSON.parse(out) as DoctorReport;
    const cfg = report.checks.filter((c) => c.name === "config" && c.status === "error");
    expect(cfg).toHaveLength(1);
    expect(cfg[0]?.detail).toContain("remove 'workspaces'");
  });

  test("flat workspace-less slack config emits no slack.config error (ADR-0042)", async () => {
    await run(["init"]);
    await writeConfig('[connectors.slack]\nchannels = ["C1", "C2"]\nself_user_ids = ["U1"]\n');
    const { out } = await run(["doctor", "--json"]);
    const report = JSON.parse(out) as DoctorReport;
    expect(report.checks.some((c) => c.name === "slack.config")).toBe(false);
    expect(report.checks.some((c) => c.name === "slack.demand")).toBe(false);
  });

  test("missing self_user_ids is an info hint (ADR-0042 決定 2)", async () => {
    await run(["init"]);
    await writeConfig('[connectors.slack]\nchannels = ["C1"]\n');
    const { code, out } = await run(["doctor", "--json"]);
    // self id degrade is info, not error/warn → exits 0.
    expect(code).toBe(0);
    const report = JSON.parse(out) as DoctorReport;
    const demand = report.checks.filter((c) => c.name === "slack.demand");
    expect(demand).toHaveLength(1);
    expect(demand[0]?.status).toBe("info");
    expect(demand[0]?.detail).toContain("DM-only");
    expect(demand[0]?.detail).toContain("self_user_ids");
  });

  // Issue #388 item 4: the discovery-drift WARN now also carries the last-sweep
  // freshness (`last swept <YYYY-MM-DD HH:MM> (<relative>)`), so an operator can
  // tell "skipped inside the 24h cadence" apart from "never swept". Read offline
  // from the `__discovery__` marker; freshness formatting reuses slack-time.ts.
  test("slack discovery drift: a persisted marker with new conversations warns with freshness (ADR-0039, #388)", async () => {
    await run(["init"]);
    await writeConfig('[connectors.slack]\nchannels = ["C1"]\n');
    // Marker: workspace 'default' had a sweep that found 3 new conversations.
    await seedSlackCursor(JSON.stringify({ C1: "1.0", __discovery__: "1000:3" }));
    const { code, out } = await run(["doctor", "--json"]);
    // Drift is a warning, not an error → exit 0.
    expect(code).toBe(0);
    const report = JSON.parse(out) as DoctorReport;
    const drift = report.checks.filter((c) => c.name === "slack.discovery");
    expect(drift).toHaveLength(1);
    expect(drift[0]?.status).toBe("warn");
    expect(drift[0]?.detail).toContain("3 new Slack conversation(s)");
    expect(drift[0]?.detail).toContain("slack conversations --new");
    // Freshness annotation: `last swept YYYY-MM-DD HH:MM (<relative>)`.
    expect(drift[0]?.detail).toMatch(/last swept \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(.+\)/);
  });

  test("slack discovery drift: a zero-count marker stays quiet (ADR-0039)", async () => {
    await run(["init"]);
    await writeConfig('[connectors.slack]\nchannels = ["C1"]\n');
    await seedSlackCursor(
      JSON.stringify({ default: { C1: "1.0" }, __discovery__: { default: "1000:0" } }),
    );
    const { out } = await run(["doctor", "--json"]);
    const report = JSON.parse(out) as DoctorReport;
    expect(report.checks.some((c) => c.name === "slack.discovery")).toBe(false);
  });

  // No `__discovery__` marker at all (never swept) stays quiet — nothing to say
  // offline (#388 item 4).
  test("slack discovery drift: no marker stays quiet (ADR-0039, #388)", async () => {
    await run(["init"]);
    await writeConfig('[connectors.slack]\nchannels = ["C1"]\n');
    await seedSlackCursor(JSON.stringify({ default: { C1: "1.0" } }));
    const { out } = await run(["doctor", "--json"]);
    const report = JSON.parse(out) as DoctorReport;
    expect(report.checks.some((c) => c.name === "slack.discovery")).toBe(false);
  });

  // Issue #388 item 4: a `discover_new = false` workspace is shown as an explicit
  // opt-out (INFO) rather than silently, so it reads as "disabled" not "cadence
  // skip". No freshness for the disabled case, and exit code stays 0.
  test("slack discovery drift: opting out (discover_new = false) shows disabled, not the stale count (ADR-0039, #388)", async () => {
    await run(["init"]);
    await writeConfig('[connectors.slack]\nchannels = ["C1"]\ndiscover_new = false\n');
    await seedSlackCursor(JSON.stringify({ C1: "1.0", __discovery__: "1000:5" }));
    const { code, out } = await run(["doctor", "--json"]);
    expect(code).toBe(0);
    const report = JSON.parse(out) as DoctorReport;
    const disc = report.checks.filter((c) => c.name === "slack.discovery");
    expect(disc).toHaveLength(1);
    expect(disc[0]?.status).toBe("info");
    expect(disc[0]?.detail).toContain("discovery disabled (discover_new = false)");
    // The (now-frozen) drift count is not nagged, and no freshness is shown.
    expect(disc[0]?.detail).not.toContain("new Slack conversation(s)");
    expect(disc[0]?.detail).not.toContain("last swept");
  });

  test("flat config with channels and no self ids: only the demand info hint (ADR-0042)", async () => {
    await run(["init"]);
    await writeConfig('[connectors.slack]\nchannels = ["C1"]\n');
    const { out } = await run(["doctor", "--json"]);
    const report = JSON.parse(out) as DoctorReport;
    // No per-workspace token probes remain (the pool is one secret, covered by
    // the connector-credential check); the self-id degrade is an info hint.
    expect(report.checks.some((c) => c.name === "slack.token")).toBe(false);
    const demand = report.checks.filter((c) => c.name === "slack.demand");
    expect(demand).toHaveLength(1);
    expect(demand[0]?.status).toBe("info");
  });

  // Issue #388 item 3: an enabled connector whose config resolves to no ingest
  // target (empty scope) is surfaced offline as a `connectors.noop` warning, so
  // the no-op is visible at diagnosis time instead of only during sync. Reuses
  // the shared pre-sync `noopWarning` detector; exit code stays unchanged.
  test("enabled slack with no channels warns nothing-to-ingest (connectors.noop) (#388)", async () => {
    await run(["init"]);
    await writeConfig("[connectors.slack]\nenabled = true\n");
    const { code, out } = await run(["doctor", "--json"]);
    // Nothing-to-ingest is a warning, not an error → still exits 0.
    expect(code).toBe(0);
    const report = JSON.parse(out) as DoctorReport;
    const noop = report.checks.filter((c) => c.name === "connectors.noop");
    expect(noop).toHaveLength(1);
    expect(noop[0]?.status).toBe("warn");
    // The connector name prefixes the shared detector's message body.
    expect(noop[0]?.detail).toContain("slack");
    expect(noop[0]?.detail).toContain("channels");
  });

  test("slack with channels configured emits no nothing-to-ingest warning (#388)", async () => {
    await run(["init"]);
    await writeConfig('[connectors.slack]\nchannels = ["C1"]\n');
    const { out } = await run(["doctor", "--json"]);
    const report = JSON.parse(out) as DoctorReport;
    expect(report.checks.some((c) => c.name === "connectors.noop")).toBe(false);
  });

  // Issue #388 item 6: the check-name column pads to the widest name in *this*
  // run (was a fixed pad(11)), so a long name like `connectors.noop` (15) no
  // longer pushes the detail column out of alignment for the shorter rows.
  test("check-name column pads to the widest name so detail stays aligned (#388)", async () => {
    await run(["init"]);
    // Enabling slack with no channels adds `connectors.noop` (15) — the widest
    // name in this run — which a fixed pad(11) would have mis-aligned against.
    await writeConfig("[connectors.slack]\nenabled = true\n");
    const { out } = await run(["doctor"]); // human-readable (not --json)
    expect(out).toContain("connectors.noop");
    // Rows render as `  [LABEL] <name padded> <detail>`; the name field starts at
    // a fixed column after the 9-char `  [LABEL] ` prefix.
    const PREFIX = 9; // "  [OK  ] ".length
    const rows = out.split("\n").filter((l) => /^ {2}\[(OK {2}|INFO|WARN|ERR )\] /.test(l));
    expect(rows.length).toBeGreaterThan(1);
    // Detail begins one space past the padded name; compute its column per row.
    const detailCols = rows.map((l) => {
      const rest = l.slice(PREFIX); // "<name padded> <detail>"
      return PREFIX + rest.length - rest.replace(/^\S+\s+/, "").length;
    });
    // Every row's detail column is identical → aligned, with no drift.
    expect(new Set(detailCols).size).toBe(1);
    // Column == prefix + widest-name-width (`connectors.noop`, 15) + 1 separator.
    expect(detailCols[0]).toBe(PREFIX + 15 + 1);
  });

  test("sync freshness: an enabled connector that never synced is a warning (#442)", async () => {
    await run(["init"]);
    await writeConfig("[connectors.github]\nrepos = []\n");
    process.env.SUASOR_CONNECTOR_GITHUB_TOKEN = "ghp_test";
    const { code, out } = await run(["doctor", "--json"]);
    // Behind-ness is a warning, not an error: the store still answers, it is
    // just answering from older data — that is a nudge, not a broken install.
    expect(code).toBe(0);
    const report = JSON.parse(out) as DoctorReport;
    const freshness = report.checks.filter((c) => c.name === "sync.freshness");
    expect(freshness).toHaveLength(1);
    expect(freshness[0]?.status).toBe("warn");
    expect(freshness[0]?.detail).toContain("github: never synced");
  });

  test("sync freshness: a recent successful run is reported ok (#442)", async () => {
    await run(["init"]);
    await writeConfig("[connectors.github]\nrepos = []\n");
    process.env.SUASOR_CONNECTOR_GITHUB_TOKEN = "ghp_test";
    const { Store } = await import("../../src/db/index.ts");
    const store = Store.open({ path: join(dir, "suasor.db") });
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    store.record({
      type: "SyncRunStarted",
      runId: `github:${startedAt}`,
      connector: "github",
      startedAt,
    });
    store.record({
      type: "SyncRunEnded",
      runId: `github:${startedAt}`,
      connector: "github",
      status: "ok",
      observed: 1,
      updated: 0,
      unchanged: 0,
      durationMs: 100,
    });
    store.close();
    const { code, out } = await run(["doctor", "--json"]);
    expect(code).toBe(0);
    const report = JSON.parse(out) as DoctorReport;
    const freshness = report.checks.find((c) => c.name === "sync.freshness");
    // The `ok` line stays visible on purpose: "last synced 0h ago" is what makes
    // the *absence* of a warning meaningful rather than merely silent.
    expect(freshness?.status).toBe("ok");
    expect(freshness?.detail).toContain("github: last synced 0h ago");
  });

  test("sync freshness: no connectors enabled → no freshness lines (#442)", async () => {
    await run(["init"]);
    const { out } = await run(["doctor", "--json"]);
    const report = JSON.parse(out) as DoctorReport;
    expect(report.checks.filter((c) => c.name === "sync.freshness")).toHaveLength(0);
  });

  test("store growth: reports size + rate as info when no ceiling is set (#498)", async () => {
    await run(["init"]);
    const { code, out } = await run(["doctor", "--json"]);
    expect(code).toBe(0);
    const report = JSON.parse(out) as DoctorReport;
    const growth = report.checks.find((c) => c.name === "store.growth");
    // No ceiling configured → informational, and it says how to get a warning.
    expect(growth?.status).toBe("info");
    expect(growth?.detail).toContain("sizeWarnBytes");
  });

  test("store growth: warns once the store is at or past the ceiling (#498)", async () => {
    await run(["init"]);
    // A 1-byte ceiling is unreachable-low on purpose: any real store is past it.
    await writeConfig("[storage]\nsizeWarnBytes = 1\n");
    const { code, out } = await run(["doctor", "--json"]);
    // Past the ceiling is a warning, not an error — the store still works, it
    // is just time to decide about retention.
    expect(code).toBe(0);
    const report = JSON.parse(out) as DoctorReport;
    const growth = report.checks.find((c) => c.name === "store.growth");
    expect(growth?.status).toBe("warn");
    expect(growth?.detail).toContain("ceiling");
  });

  test("store growth: stays ok when the ceiling is far away (#498)", async () => {
    await run(["init"]);
    await writeConfig("[storage]\nsizeWarnBytes = 1099511627776\n"); // 1 TiB
    const { out } = await run(["doctor", "--json"]);
    const report = JSON.parse(out) as DoctorReport;
    expect(report.checks.find((c) => c.name === "store.growth")?.status).toBe("ok");
  });

  test("warns when a local root overlaps an enabled API connector (#514)", async () => {
    await run(["init"]);
    // The local connector validates that roots exist, so build a directory that
    // actually looks like a Box mount.
    const { mkdirSync } = await import("node:fs");
    const boxRoot = join(dir, "Box", "Projects");
    mkdirSync(boxRoot, { recursive: true });
    await writeConfig(
      `[connectors.local]\nroots = ["${boxRoot}"]\n\n[connectors.box]\nfolders = []\n`,
    );
    process.env.SUASOR_CONNECTOR_BOX_TOKEN = "box_test";
    const { code, out } = await run(["doctor", "--json"]);
    // A warning, not an error: both routes work, they just duplicate.
    expect(code).toBe(0);
    const report = JSON.parse(out) as DoctorReport;
    const overlap = report.checks.find((c) => c.name === "connectors.overlap");
    expect(overlap?.status).toBe("warn");
    expect(overlap?.detail).toContain("ingested twice");
    delete process.env.SUASOR_CONNECTOR_BOX_TOKEN;
  });

  test("no overlap warning when only the local connector is enabled (#514)", async () => {
    await run(["init"]);
    const { mkdirSync } = await import("node:fs");
    const boxRoot = join(dir, "Box", "Projects");
    mkdirSync(boxRoot, { recursive: true });
    await writeConfig(`[connectors.local]\nroots = ["${boxRoot}"]\n`);
    const { out } = await run(["doctor", "--json"]);
    const report = JSON.parse(out) as DoctorReport;
    // Reading a synced folder is fine on its own — nothing is duplicated.
    expect(report.checks.filter((c) => c.name === "connectors.overlap")).toHaveLength(0);
  });
});
