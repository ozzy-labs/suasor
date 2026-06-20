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
  "decisions",
  "inbox",
  "proposals",
  "commitments",
  "links",
  "persons",
  "person_identities",
];

export class DoctorCommand extends Command {
  static override paths = [["doctor"]];

  static override usage = Command.Usage({
    category: "Maintenance",
    description: "One-shot health check of config, database, embedding, and connectors.",
    details: `
      Aggregates config / database / embedding-backend / connector-credential
      checks into one report so you can see what is wired and what is missing.
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

    // 2. database — file exists (do not create it) + core projection tables present.
    const dbPath = config?.storage.dbPath ?? null;
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
    if (config !== null) {
      const enabled: string[] = [];
      const missingCred: string[] = [];
      for (const name of connectorNames()) {
        const slice = config.connectors[name];
        if (slice === undefined || slice.enabled === false) continue;
        enabled.push(name);
        const secrets = connectorSecretNames(name);
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
