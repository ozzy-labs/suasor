/**
 * `suasor doctor [--json]` — one-shot environment health check.
 *
 * Aggregates the diagnostics that were previously scattered across
 * `connectors list` / `embeddings status` / `db migrate` / `init` into a single
 * command so onboarding and support can see "what is wired and what is missing"
 * at a glance. Read-only: it inspects config, the local store, the embedding
 * backend setting, and connector credentials, but writes nothing (it never
 * creates a missing database — that is `suasor init`'s job, NFR-PRV-4 keeps
 * secret values out of the output).
 *
 * Exit code: 1 when any check is `error` (cron / CI can gate on it), else 0.
 * `warn` / `info` do not fail. Lazy-import discipline (NFR-PRF-1): config loader,
 * DB layer, and keychain are imported inside `execute`; only the cheap registry
 * name lookup is eager (as in `connectors list`).
 */

import { existsSync } from "node:fs";
import { Command, Option } from "clipanion";
import { connectorNames, connectorSecretNames } from "../../connectors/registry.ts";

/** Severity of a single check (worst across checks sets the exit code). */
type CheckStatus = "ok" | "info" | "warn" | "error";

/** One diagnostic line. */
interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

/** Core projection tables a migrated store must have (src/db/schema.ts). */
const PROJECTION_TABLES = [
  "sources",
  "tasks",
  "sync_runs",
  "decisions",
  "inbox",
  "proposals",
  "commitments",
  "links",
  "persons",
  "person_identities",
  "slack_channels",
  "slack_teams",
];

export class DoctorCommand extends Command {
  static override paths = [["doctor"]];

  static override usage = Command.Usage({
    category: "Maintenance",
    description: "One-shot health check of config, database, embedding, and connectors.",
    details: `
      Aggregates config / database / embedding-backend / connector-credential
      checks into one report so you can see what is wired and what is missing.
      Also warns when the same Slack channel id is listed under multiple
      workspace aliases: sync de-duplicates it (owner-wins, ADR-0038) but the
      redundant declaration is surfaced here so you can spot it without a sync.
      Read-only (never creates a database; secret values are never printed,
      NFR-PRV-4). Exits 1 when any check is an error, so cron / CI can gate on it.
      Use --json for machine-readable output.
    `,
    examples: [
      ["Run all checks", "suasor doctor"],
      ["Machine-readable output", "suasor doctor --json"],
    ],
  });

  json = Option.Boolean("--json", false, {
    description: "Emit the checks as JSON instead of a human-readable report.",
  });

  override async execute(): Promise<number> {
    const [{ loadConfig, resolveConfigDir }, { Store }, { resolveSecret }, { join }] =
      await Promise.all([
        import("../../config/index.ts"),
        import("../../db/index.ts"),
        import("../../connectors/secrets.ts"),
        import("node:path"),
      ]);

    const checks: Check[] = [];

    // 1. config — config.toml present + loads (defaults are valid without a file).
    const configDir = resolveConfigDir();
    const configPath = join(configDir, "config.toml");
    let config: Awaited<ReturnType<typeof loadConfig>> | null = null;
    try {
      config = await loadConfig();
      checks.push(
        existsSync(configPath)
          ? { name: "config", status: "ok", detail: `loaded ${configPath}` }
          : {
              name: "config",
              status: "warn",
              detail: `no config.toml in ${configDir} (using defaults; run \`suasor init\`)`,
            },
      );
    } catch (err) {
      checks.push({
        name: "config",
        status: "error",
        detail: `failed to load config: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // 1b. config warnings — keys accepted by the schema but silently dropped at
    //    runtime (ADR-0007 silent-error eradication): an external embedding
    //    backend (openai/voyage) with no API key resolved (→ recall falls back to
    //    FTS) or a set-but-unused [llm] backend (inference is delegated to the
    //    host LLM). Degrade behavior is unchanged; this just makes the no-op
    //    visible. The external-backend key is resolved here (keychain/env).
    if (config !== null) {
      const { collectConfigWarnings } = await import("../../config/index.ts");
      const { resolveEmbeddingApiKeyPresent } = await import("../../retrieval/embedding/index.ts");
      const embeddingApiKeyPresent = await resolveEmbeddingApiKeyPresent(config.embedding.backend);
      for (const warning of collectConfigWarnings({ ...config, embeddingApiKeyPresent })) {
        checks.push({ name: warning.key, status: "warn", detail: warning.message });
      }
    }

    // 2. database — file exists (do not create it) + core projection tables present.
    const dbPath = config?.storage.dbPath ?? null;
    let dbReady = false; // gates the maintenance-hint probes below.
    if (config === null) {
      checks.push({ name: "database", status: "error", detail: "skipped (config did not load)" });
    } else if (dbPath === null) {
      checks.push({
        name: "database",
        status: "error",
        detail: "storage.dbPath is not configured",
      });
    } else if (!existsSync(dbPath)) {
      checks.push({
        name: "database",
        status: "error",
        detail: `not found at ${dbPath} (run \`suasor init\` or \`suasor db migrate\`)`,
      });
    } else {
      const store = Store.open({ path: dbPath, embeddingDim: config.embedding.dim });
      try {
        const rows = store.connection.sqlite
          .query("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as Array<{ name: string }>;
        const present = new Set(rows.map((r) => r.name));
        const missing = PROJECTION_TABLES.filter((t) => !present.has(t));
        dbReady = missing.length === 0;
        checks.push(
          missing.length === 0
            ? {
                name: "database",
                status: "ok",
                detail: `${dbPath} (${PROJECTION_TABLES.length} projection tables)`,
              }
            : {
                name: "database",
                status: "error",
                detail: `missing tables: ${missing.join(", ")} (run \`suasor db migrate\`)`,
              },
        );
      } finally {
        store.close();
      }
    }

    // 3. embedding — report the configured backend; disabled is informational.
    if (config !== null) {
      const { backend, model } = config.embedding;
      checks.push(
        backend === "disabled"
          ? {
              name: "embedding",
              status: "info",
              detail: "backend disabled (recall falls back to FTS; see docs/guide/embedding.md)",
            }
          : { name: "embedding", status: "ok", detail: `backend=${backend} model=${model}` },
      );

      // 3b. embedding dim — probe the model's actual output dimension once and
      //     compare it to [embedding].dim, which sizes the vec0 table. A mismatch
      //     makes every vector insert fail and silently degrades recall to empty
      //     (Issue #267). Only probe when a backend is enabled AND an embedder can
      //     build (external backends need a key); skip otherwise (no key → recall
      //     already degrades, surfaced by the readiness warning above). The probe
      //     embeds one short string — for external backends that is one egress
      //     (ADR-0003), acceptable for an explicit health check.
      if (backend !== "disabled") {
        const { createEmbedderResolved } = await import("../../retrieval/embedding/index.ts");
        const embedder = await createEmbedderResolved({
          backend,
          baseUrl: config.embedding.baseUrl,
          model: config.embedding.model,
          // dim intentionally omitted: probe the raw model output, compare below.
          // Fail fast for a health check — one attempt, short timeout — so a
          // missing sidecar / hung API surfaces a probe warning quickly instead
          // of waiting out the runtime retry/backoff budget.
          maxRetries: 1,
          requestTimeoutMs: 5000,
        });
        if (embedder !== null) {
          try {
            const [vector] = await embedder.embed(["healthcheck"]);
            const actual = vector?.length ?? 0;
            checks.push(
              actual === config.embedding.dim
                ? {
                    name: "embedding.dim",
                    status: "ok",
                    detail: `model output ${actual}-dim matches [embedding].dim`,
                  }
                : {
                    name: "embedding.dim",
                    status: "error",
                    detail:
                      `model "${model}" returns ${actual}-dim but [embedding].dim is ${config.embedding.dim}; ` +
                      `vector inserts fail and recall degrades to empty. Set [embedding].dim = ${actual} ` +
                      "(needs a fresh DB / delete + rebuild + re-sync). See docs/guide/embedding.md.",
                  },
            );
          } catch (err) {
            checks.push({
              name: "embedding.dim",
              status: "warn",
              detail: `could not probe embedding dimension: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
        }
      }
    }

    // 4. extraction — report the configured backend; disabled is informational.
    if (config !== null) {
      const { backend, version } = config.extraction;
      checks.push(
        backend === "disabled"
          ? {
              name: "extraction",
              status: "info",
              detail: "backend disabled (Office/PDF stay name-only; see docs/guide/extraction.md)",
            }
          : {
              name: "extraction",
              status: "ok",
              detail: `backend=${backend} version=${version} (run \`suasor extraction status\` for coverage)`,
            },
      );
    }

    // 5. connectors — enabled connectors whose credential is missing are warnings.
    //    A disabled / unconfigured connector that nonetheless has a stored
    //    credential is surfaced too: the user ran `auth set` but never enabled
    //    `[connectors.<name>]`, so a "no connectors enabled" report alone would
    //    hide that token (#161). Only credential *presence* is probed, never the
    //    value (NFR-PRV-4).
    if (config !== null) {
      const enabled: string[] = [];
      const missingCred: string[] = [];
      const storedNotEnabled: string[] = [];
      for (const name of connectorNames()) {
        const slice = config.connectors[name];
        const isEnabled = slice !== undefined && slice.enabled !== false;
        const secrets = connectorSecretNames(name);
        if (!isEnabled) {
          // Not enabled: flag it only if a credential is already stored.
          for (const secret of secrets) {
            if ((await resolveSecret(name, secret)) !== null) {
              storedNotEnabled.push(name);
              break;
            }
          }
          continue;
        }
        enabled.push(name);
        if (secrets.length === 0) continue; // needs no auth (e.g. web)
        for (const secret of secrets) {
          if ((await resolveSecret(name, secret)) === null) {
            missingCred.push(name);
            break;
          }
        }
      }
      if (enabled.length === 0) {
        checks.push({
          name: "connectors",
          status: "info",
          detail: "no connectors enabled (add a [connectors.<name>] section)",
        });
      } else if (missingCred.length > 0) {
        checks.push({
          name: "connectors",
          status: "warn",
          detail: `${enabled.length} enabled; missing credential: ${missingCred.join(", ")}`,
        });
      } else {
        checks.push({
          name: "connectors",
          status: "ok",
          detail: `${enabled.length} enabled, all credentials configured`,
        });
      }
      if (storedNotEnabled.length > 0) {
        checks.push({
          name: "connectors",
          status: "warn",
          detail:
            `credential stored but not enabled: ${storedNotEnabled.join(", ")} ` +
            "(add a [connectors.<name>] section, or set enabled = true to start syncing)",
        });
      }
    }

    // 5b. slack shared channels — the same global Slack channel id listed under
    //    multiple workspace aliases (ADR-0038 Layer 3, early detection). Sync
    //    de-dups these owner-wins so nothing is double-ingested (Layer 1), but
    //    surfacing the redundant declaration here lets the user notice it without
    //    running a sync — and names the very owner that will ingest it, since the
    //    owner rule (lexicographically smallest alias) is shared with sync via
    //    `channelOwnership`. Warn, not error: the config still works (dedup
    //    absorbs it); it is just redundant. Runs whenever a [connectors.slack]
    //    slice exists (enabled or not — a duplicate is worth flagging while the
    //    connector is still being set up). Quiet when nothing is shared, so the
    //    common single-workspace / non-overlapping case adds no line.
    if (config !== null && config.connectors.slack !== undefined) {
      const [{ SlackConnectorConfig, resolveWorkspaces }, { channelOwnership }] = await Promise.all(
        [import("../../connectors/slack.ts"), import("../../connectors/slack/dedup.ts")],
      );
      const slack = SlackConnectorConfig.parse(config.connectors.slack);
      const { shared } = channelOwnership(resolveWorkspaces(slack));
      for (const s of shared) {
        checks.push({
          name: "slack",
          status: "warn",
          detail:
            `channel ${s.channel} configured under [${s.aliases.join(", ")}]; ` +
            `only owner '${s.owner}' will ingest it (shared-channel de-dup, ADR-0038)`,
        });
      }
    }

    // 6. maintenance — actionable backlog hints from the derived substrates
    //    (Issue #202). Only when the store is migrated (dbReady) and the relevant
    //    backend is enabled: a disabled backend has no backlog to drain. Read-only
    //    SELECTs over the existing meta tables; no hint line is emitted when there
    //    is nothing to do (so a settled store stays quiet).
    if (config !== null && dbReady && dbPath !== null) {
      const store = Store.open({ path: dbPath, embeddingDim: config.embedding.dim });
      try {
        const sqlite = store.connection.sqlite;
        // Embeddings: pending (no vector) / stale (different model) backlog.
        if (config.embedding.backend !== "disabled") {
          const { createEmbedderResolved, embeddingStatus } = await import(
            "../../retrieval/embedding/index.ts"
          );
          // Resolve the API key for external backends so the active model is
          // known and drift (stale) is computed against it (null only when no key
          // → everything reads as pending, matching the no-embedder degrade).
          const embedder = await createEmbedderResolved(config.embedding);
          const status = embeddingStatus(sqlite, embedder, config.embedding.backend);
          if (status.totals.pending > 0) {
            checks.push({
              name: "maintenance",
              status: "warn",
              detail:
                `pending embeddings: ${status.totals.pending} — ` +
                "run `suasor embeddings drain` (`embeddings list-failed` to inspect)",
            });
          }
          if (status.totals.stale > 0) {
            checks.push({
              name: "maintenance",
              status: "warn",
              detail:
                `stale embeddings: ${status.totals.stale} (model drift) — ` +
                "run `suasor embeddings rebuild`",
            });
          }
        }
        // Extraction: version drift (stale) / never-attempted (pending) backlog.
        if (config.extraction.backend !== "disabled") {
          const { extractionStatus } = await import("../../extraction/index.ts");
          const status = extractionStatus(sqlite, {
            backend: config.extraction.backend,
            version: config.extraction.version,
          });
          if (status.totals.stale > 0) {
            checks.push({
              name: "maintenance",
              status: "warn",
              detail:
                `extraction version drift: ${status.totals.stale} source(s) at an older version — ` +
                "run the owning connector's sync (e.g. `suasor local sync` / `suasor box sync` / `suasor google sync`) to re-extract",
            });
          }
          if (status.totals.pending > 0) {
            checks.push({
              name: "maintenance",
              status: "warn",
              detail:
                `pending extractions: ${status.totals.pending} — ` +
                "run the owning connector's sync (e.g. `suasor local sync` / `suasor box sync` / `suasor google sync`); " +
                "`extraction list-pending` to inspect",
            });
          }
        }
      } finally {
        store.close();
      }
    }

    const hasError = checks.some((c) => c.status === "error");

    if (this.json) {
      this.context.stdout.write(`${JSON.stringify({ ok: !hasError, checks }, null, 2)}\n`);
      return hasError ? 1 : 0;
    }

    const label: Record<CheckStatus, string> = {
      ok: "OK  ",
      info: "INFO",
      warn: "WARN",
      error: "ERR ",
    };
    this.context.stdout.write("suasor doctor\n");
    for (const c of checks) {
      this.context.stdout.write(`  [${label[c.status]}] ${c.name.padEnd(11)} ${c.detail}\n`);
    }
    const warnings = checks.filter((c) => c.status === "warn").length;
    const errors = checks.filter((c) => c.status === "error").length;
    this.context.stdout.write(`Summary: ${warnings} warning(s), ${errors} error(s)\n`);
    return hasError ? 1 : 0;
  }
}
