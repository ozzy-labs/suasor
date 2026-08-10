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
import { SuasorCommand } from "../base-command.ts";
import { docsUrl } from "../doc-ref.ts";

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
  "demand_seen",
  "links",
  "persons",
  "person_identities",
  "slack_channels",
  "slack_teams",
];

export class DoctorCommand extends SuasorCommand {
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
      For a multi-workspace Slack config
      ([connectors.slack.workspaces.<alias>]), each named workspace's token
      (connector:slack:<alias>:token) is probed — a missing per-workspace token
      is a warning (sync skips that workspace, ADR-0014) and a missing
      self_user_id is info (demand.list degrades to DM-only, ADR-0012/ADR-0041).
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
    const [
      { loadConfig, resolveConfigDir },
      { Store, DEFAULT_VEC_TABLE, VEC_META_TABLE },
      { resolveSecret },
      { join },
    ] = await Promise.all([
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
    //    FTS) or a leftover retired [llm] section (Suasor never calls an LLM —
    //    the host is the LLM). Degrade behavior is unchanged; this just makes
    //    the no-op visible. The external-backend key is resolved here (keychain/env).
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

    // 2b. at-rest posture (ADR-0048 / #529). Two checks, not one, because the
    //    confidence differs: permissions are a fact Suasor reads back off disk,
    //    while full-disk encryption is a premise the OS owns. Reporting them
    //    together would let an `unknown` FDE verdict taint a permission result
    //    that is certain.
    if (config !== null && dbPath !== null) {
      const { inspectPermissions, storePaths, formatMode, detectDiskEncryption } = await import(
        "../../db/at-rest.ts"
      );
      const { PERMISSIONS_ENFORCEABLE } = await import("../../db/file-permissions.ts");

      if (!PERMISSIONS_ENFORCEABLE) {
        checks.push({
          name: "storage.permissions",
          status: "info",
          detail:
            "not applicable on this platform (Windows maps chmod to the read-only bit); " +
            "rely on NTFS ACLs and full-disk encryption",
        });
      } else {
        // The config dir is included because it is the one path Suasor does not
        // re-tighten on every run: `openDatabase` re-applies the file mode at
        // each open (so a store created before this existed is upgraded in
        // place), but the directory is only set at `init`.
        const found = [...storePaths(dbPath), configDir]
          .map(inspectPermissions)
          .filter((p) => p.mode !== null);
        const exposed = found.filter((p) => p.worldReadable);
        checks.push(
          exposed.length === 0
            ? {
                name: "storage.permissions",
                status: "ok",
                detail: `owner-only (${found.map((p) => formatMode(p.mode ?? 0)).join(" / ")})`,
              }
            : {
                // Every ingested body is in these files, so another local user
                // reading them is the whole store, not a fragment.
                name: "storage.permissions",
                status: "warn",
                detail:
                  `readable by other users: ${exposed
                    .map((p) => `${p.path} (${formatMode(p.mode ?? 0)})`)
                    .join(", ")} — run \`chmod 600\` on files and \`chmod 700\` on the ` +
                  "config dir; anything Suasor creates from now on is owner-only",
              },
        );
      }

      const fde = await detectDiskEncryption();
      checks.push({
        name: "storage.disk_encryption",
        // `unknown` is a warn, not an ok: ADR-0048 leans on the OS for at-rest
        // protection, so an unverified premise is exactly what to surface.
        status: fde.state === "on" ? "ok" : "warn",
        detail:
          fde.state === "on"
            ? fde.detail
            : `${fde.detail}. The store is plaintext SQLite (ADR-0048): full-disk ` +
              "encryption is what protects it from a lost or stolen disk",
      });
    }

    // 3. embedding — report the configured backend; disabled is informational.
    if (config !== null) {
      const { backend, model } = config.embedding;
      checks.push(
        backend === "disabled"
          ? {
              name: "embedding",
              status: "info",
              detail: `backend disabled (recall falls back to FTS; see ${docsUrl("guide/embedding.md")})`,
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
                      `(needs a fresh DB / delete + rebuild + re-sync). See ${docsUrl("guide/embedding.md")}.`,
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

    // 3b. store growth (Issue #498 / ADR-0047). The retention decision is
    //     deliberately opt-in and off by default, so the only way it gets made
    //     at the right time is if growth is visible *before* it hurts. Reports
    //     size + average rate always; warns only against an explicit ceiling.
    if (config !== null && dbReady && dbPath !== null) {
      const { storeInfo, formatBytes } = await import("../../db/store-info.ts");
      const growthStore = Store.open({ path: dbPath, embeddingDim: config.embedding.dim });
      try {
        const info = storeInfo(growthStore.connection.sqlite, dbPath, {
          embeddingDim: config.embedding.dim,
        });
        const size = info.fileSizeBytes ?? 0;
        const rate =
          info.bytesPerDay === null
            ? "growth unknown (< 1 day of history)"
            : `~${formatBytes(info.bytesPerDay)}/day`;
        const ceiling = config.storage.sizeWarnBytes;
        if (ceiling === null) {
          checks.push({
            name: "store.growth",
            status: "info",
            detail: `${formatBytes(size)}, ${rate} (set [storage].sizeWarnBytes for a ceiling warning)`,
          });
        } else if (size >= ceiling) {
          checks.push({
            name: "store.growth",
            status: "warn",
            detail: `${formatBytes(size)} is at or past the ${formatBytes(ceiling)} ceiling — see ${docsUrl("adr/0047-storage-lifecycle.md")} for opt-in retention`,
          });
        } else {
          // Days-to-ceiling is what makes the number actionable: "6 GB" says
          // nothing, "reaches the ceiling in 12 days" is a decision prompt.
          const remaining = ceiling - size;
          const days =
            info.bytesPerDay !== null && info.bytesPerDay > 0
              ? Math.floor(remaining / info.bytesPerDay)
              : null;
          const eta = days === null ? "" : `, ceiling in ~${days} day(s)`;
          checks.push({
            name: "store.growth",
            status: days !== null && days <= 30 ? "warn" : "ok",
            detail: `${formatBytes(size)} of ${formatBytes(ceiling)}, ${rate}${eta}`,
          });
        }
      } finally {
        growthStore.close();
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
              detail:
                "backend disabled (Office/PDF stay name-only). Start the bundled sidecar with " +
                '`suasor extraction serve` and set [extraction].backend = "markitdown"; see ' +
                docsUrl("guide/extraction.md"),
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
      const {
        noopWarnings,
        missingSettingWarnings,
        accountSecretProbes,
        demotedDefaultAccountNotice,
        advisoryLabel,
      } = await import("../../connectors/noop-check.ts");
      const enabled: string[] = [];
      const missingCred: string[] = [];
      const storedNotEnabled: string[] = [];
      // `[connectors.<name>]` demoted to inheritance defaults by an `accounts`
      // table with no `default` entry (ADR-0050) — reported at the confidence the
      // evidence supports (see `demotedDefaultAccountNotice`).
      const demotedDefaults: Array<{ name: string; severity: "warn" | "info"; message: string }> =
        [];
      // Enabled connectors whose config slice resolves to "enabled but no ingest
      // target" (empty scope). Surfaced offline here so the no-op is visible at
      // diagnosis time instead of only as a warning during sync (Issue #388).
      const noopScoped: Array<{ name: string; message: string }> = [];
      // Enabled connectors missing a non-secret setting they cannot work without
      // (ADR-0049 / Issue #478) — the non-Slack counterpart of the `slack.config`
      // check. Kept separate from `noopScoped` because the severities differ: an
      // empty scope still syncs (0 observed), an empty `clientId` / `host` cannot
      // authenticate or address the API at all.
      const missingSettings: Array<{ name: string; message: string }> = [];
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
        // slice is defined here (isEnabled implies it). `noopWarning` is a pure,
        // offline detector: it returns a warning body when the slice has no ingest
        // target, or null otherwise. Exit code stays unchanged (warn only).
        if (slice !== undefined) {
          for (const advisory of noopWarnings(name, slice)) {
            noopScoped.push({
              name: advisoryLabel(name, advisory.account),
              message: advisory.message,
            });
          }
          for (const advisory of missingSettingWarnings(name, slice)) {
            missingSettings.push({
              name: advisoryLabel(name, advisory.account),
              message: advisory.message,
            });
          }
          // A default account demoted to inheritance defaults (ADR-0050). The
          // stored-credential probe is what separates the two confidence levels,
          // so resolve it rather than guessing from config alone — but lazily:
          // the notice does not apply to most configs, and an eager probe would
          // charge every doctor run a keychain read per connector for it.
          const notice = await demotedDefaultAccountNotice(name, slice, async () => {
            const resolved = await Promise.all(
              secrets.map((secret) => resolveSecret(name, secret)),
            );
            return resolved.some((value) => value !== null);
          });
          if (notice !== null) demotedDefaults.push({ name, ...notice });
        }
        if (secrets.length === 0) continue; // needs no auth (e.g. web)
        // Per account (ADR-0050): every configured account needs its own
        // credential, and a single-account connector resolves to exactly the
        // pre-ADR-0050 probe (base secret names, unlabelled). Every account is
        // reported, not just the first — "which accounts are unusable" is the
        // whole question here.
        for (const probe of accountSecretProbes(name, slice ?? {})) {
          if ((await resolveSecret(name, probe.secret)) !== null) continue;
          const label = advisoryLabel(name, probe.account);
          if (!missingCred.includes(label)) missingCred.push(label);
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
      // Enabled-but-nothing-to-ingest: one warn line per connector whose scope is
      // empty (e.g. slack enabled with no channels). The message body comes from
      // the shared pre-sync detector; prefix it with the connector name to match
      // the sync-time `warning: <name>: ...` formatting (Issue #388).
      for (const { name, message } of noopScoped) {
        checks.push({ name: "connectors.noop", status: "warn", detail: `${name}: ${message}` });
      }
      // Enabled-but-unaddressable: one error line per connector missing a
      // required non-secret setting (ADR-0049). An error, not a warning: unlike
      // the no-op case the sync does not succeed with 0 observed — it fails with
      // the vendor's own opaque message, which is exactly the "no silent wrong
      // answer" shape ADR-0007 asks doctor to pre-empt. Slack's equivalent
      // (`slack.config`) has been an error since ADR-0042 決定 9.
      for (const { name, message } of missingSettings) {
        checks.push({ name: "connectors.config", status: "error", detail: `${name}: ${message}` });
      }
      // The flat keys demoted to inheritance defaults by an `accounts` table with
      // no `default` entry (ADR-0050). `warn` only when a stored credential shows
      // the account really existed; otherwise `info`, because nothing in the
      // config distinguishes "was ingesting" from "never was" and inventing that
      // distinction would be the guess this check exists to avoid.
      for (const { name, severity, message } of demotedDefaults) {
        checks.push({
          name: "connectors.accounts",
          status: severity,
          detail: `${name}: ${message}`,
        });
      }

      // 5b-2. Mail connector enabled but no self_addresses (Issue #488): email
      //      demand is derived from "addressed to me and unanswered", so
      //      without the operator's own addresses it is *silently always
      //      empty* — the same failure shape as Slack's self_user_ids.
      //      Per account (ADR-0050): the work account is usually the one whose
      //      addresses are missing, and a connector-level check would call it
      //      configured because the personal account has some.
      const { accountSlices } = await import("../../connectors/multi-account.ts");
      for (const name of ["google", "ms-graph"]) {
        const connectorSlice = config.connectors[name];
        if (connectorSlice === undefined || connectorSlice.enabled === false) continue;
        for (const account of accountSlices(connectorSlice)) {
          const resources = (account.slice.resources as string[] | undefined) ?? [];
          const ingestsMail =
            resources.length === 0 || resources.includes("gmail") || resources.includes("mail");
          if (!ingestsMail) continue;
          const addresses = (account.slice.self_addresses as string[] | undefined) ?? [];
          if (addresses.length > 0) continue;
          const section = account.declared
            ? `[connectors.${name}.accounts.${account.name}]`
            : `[connectors.${name}]`;
          checks.push({
            name: "connectors.self_addresses",
            status: "warn",
            detail:
              `${advisoryLabel(name, account.declared ? account.name : null)}: no self_addresses ` +
              `configured — email demand (unanswered threads addressed to you) is always empty. ` +
              `Add your own addresses, including aliases and any team@ you answer, to ` +
              `${section}.self_addresses`,
          });
        }
      }

      // 5c. local ↔ API connector overlap (Issue #514). An OS-synced Box /
      //     OneDrive / Drive mount read as plain files, plus that service's own
      //     API connector, ingests every shared file twice under two ids —
      //     duplicate sources, FTS rows, embeddings and search hits. The Slack
      //     equivalent (shared channels) has had a check since ADR-0038; this
      //     one was invisible until someone spotted the same doc twice.
      const localRoots = (config.connectors.local?.roots as string[] | undefined) ?? [];
      if (localRoots.length > 0) {
        const { detectLocalOverlaps } = await import("../../connectors/local-overlap.ts");
        for (const overlap of detectLocalOverlaps(localRoots, enabled)) {
          checks.push({ name: "connectors.overlap", status: "warn", detail: overlap.message });
        }
      }

      // 5d. sync freshness (Issue #442). Credentials being present says the
      // connector *could* sync; this says whether it actually has. The silent
      // failure this catches is a scheduled sync that stopped running (a cron
      // entry with no `suasor` on PATH, a revoked token) — the store keeps
      // answering, just from last week. Requires a migrated DB to read
      // `sync_runs` from; skipped otherwise (the database check already errored).
      if (dbReady && dbPath !== null && enabled.length > 0) {
        const [{ deriveSyncFreshness }, { listSyncRuns }] = await Promise.all([
          import("../../connectors/freshness.ts"),
          import("../../mcp/queries.ts"),
        ]);
        const freshStore = Store.open({ path: dbPath, embeddingDim: config.embedding.dim });
        try {
          const freshness = deriveSyncFreshness(
            enabled,
            listSyncRuns(freshStore.connection.sqlite),
            {
              expectedIntervalHours: config.sync.expectedIntervalHours,
              safetyFactor: config.sync.safetyFactor,
              perConnectorIntervalHours: config.sync.perConnectorIntervalHours,
            },
          );
          for (const f of freshness) {
            checks.push({
              name: "sync.freshness",
              // `ok` stays visible: "last synced 2h ago" is the line that makes
              // the absence of a warning meaningful rather than merely quiet.
              status: f.state === "ok" ? "ok" : "warn",
              detail: `${f.connector}: ${f.detail}`,
            });
          }
        } finally {
          freshStore.close();
        }
      }
    }

    // 5b. (removed) shared-channel warn — the owner-wins dedup layers were
    //    dropped with ADR-0042: the canonical externalId (`slack:<channel>:<ts>`)
    //    collapses a channel listed under multiple aliases at ingest, so a
    //    duplicated declaration is a redundant fetch, not a correctness issue.
    if (config !== null && config.connectors.slack !== undefined) {
      const { SlackConnectorConfig, rejectLegacySlackConfig, readDiscoveryMarker } = await import(
        "../../connectors/slack.ts"
      );
      // 5c. legacy config shape (ADR-0042 決定 9): surface the un-migrated
      //    ADR-0014 multi-workspace shape as an error with the mechanical
      //    migration (the same ConfigError sync raises). Skip the rest of the
      //    slack checks — they parse the flat shape.
      let slack: import("../../connectors/slack.ts").SlackConnectorConfig | null = null;
      try {
        rejectLegacySlackConfig(config.connectors.slack);
        slack = SlackConnectorConfig.parse(config.connectors.slack);
      } catch (error) {
        checks.push({
          name: "slack.config",
          status: "error",
          detail: error instanceof Error ? error.message : String(error),
        });
      }

      // 5c'. self ids (ADR-0012 / ADR-0042 決定 2): without `self_user_ids`,
      //    `demand.list` degrades to DM-only. Info only — never an error.
      //    Presence only, never a value (NFR-PRV-4).
      if (slack && (slack.self_user_ids ?? []).length === 0 && slack.channels.length > 0) {
        checks.push({
          name: "slack.demand",
          status: "info",
          detail:
            "no self_user_ids configured; `demand.list` degrades to DM-only (no `<@you>` " +
            "mentions, ADR-0012/ADR-0041). Run `suasor slack auth test` and copy each user " +
            "token's userId into [connectors.slack].self_user_ids.",
        });
      }

      // 5d. slack discovery drift + freshness (ADR-0039 Layer 2, offline) —
      //    surface how many newly-joined conversations the last `slack sync` sweep
      //    found that are still not in `channels`, and *when* that sweep ran.
      //    Doctor is a diagnostic and does NOT sweep the network itself (ADR-0039
      //    §Decision): it reads the `__discovery__` drift marker the sync-time
      //    sweep persisted in the connector cursor. The last-sweep freshness lets
      //    an operator tell "skipped inside the 24h cadence" apart from "never
      //    swept", and a `discover_new = false` workspace is shown as an explicit
      //    opt-out (INFO) rather than silently — resolving the ambiguity Issue
      //    #388 item 4 called out. Exit code unchanged (warn/info only). A marker
      //    that is enabled-and-settled (count 0) or absent stays quiet. Requires a
      //    migrated store (the cursor lives in the event log).
      if (slack && dbReady && dbPath !== null) {
        const [{ lastCursor }, { formatSlackTs }] = await Promise.all([
          import("../../connectors/sync.ts"),
          import("../slack-time.ts"),
        ]);
        const driftStore = Store.open({ path: dbPath, embeddingDim: config.embedding.dim });
        try {
          const marker = readDiscoveryMarker(lastCursor(driftStore.connection.sqlite, "slack"));
          if (marker !== null) {
            // Opted out (discover_new = false): show the disabled state instead
            // of a now-frozen drift count, so it reads as a deliberate opt-out
            // rather than a cadence skip.
            if (slack.discover_new === false) {
              checks.push({
                name: "slack.discovery",
                status: "info",
                detail: "discovery disabled (discover_new = false)",
              });
            } else if (marker.newCount > 0) {
              // Enabled + drift: the actionable warning, annotated with the last
              // sweep's freshness. `lastSweptMs` is epoch ms; formatSlackTs takes
              // a Slack `ts` (epoch seconds), so scale down by 1000 to reuse it.
              checks.push({
                name: "slack.discovery",
                status: "warn",
                detail:
                  `${marker.newCount} new Slack conversation(s) visible but not in config — ` +
                  "run `suasor slack conversations --new` to review (none ingested, ADR-0039); " +
                  `last swept ${formatSlackTs(String(marker.lastSweptMs / 1000))}`,
              });
            }
            // Enabled but nothing new: settled, stay quiet.
          }
        } finally {
          driftStore.close();
        }
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
        // Embedding substrate integrity: vec0 (vectors) and embeddings_meta
        // (provenance) are written together on ingest and cleared together on
        // rebuild (ADR-0005 §5), so their row counts must match. A divergence is
        // silent corruption — the pre-fix `projections rebuild` cleared vec0 but
        // left embeddings_meta, so `embeddings status` / `drain` reported full
        // coverage while every vector was gone and recall returned empty. Error
        // (not warn) so cron / CI catches it; the fix is a `projections rebuild`
        // (now symmetric) followed by `embeddings drain`. Runs whenever both
        // tables exist, regardless of the active backend (leftover drift outlives
        // a since-disabled backend). Read-only COUNT(*)s; quiet when they match.
        const tableNames = new Set(
          sqlite
            .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
            .all()
            .map((r) => r.name),
        );
        if (tableNames.has(DEFAULT_VEC_TABLE) && tableNames.has(VEC_META_TABLE)) {
          const vecN =
            sqlite.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${DEFAULT_VEC_TABLE}`).get()
              ?.n ?? 0;
          const metaN =
            sqlite.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${VEC_META_TABLE}`).get()
              ?.n ?? 0;
          if (vecN !== metaN) {
            checks.push({
              name: "embedding.substrate",
              status: "error",
              detail:
                `vec0 has ${vecN} vector(s) but embeddings_meta has ${metaN} provenance row(s) — ` +
                "the two must match (they diverge silently and recall breaks). Run " +
                "`suasor projections rebuild` then `suasor embeddings drain` to resync (ADR-0005 §5).",
            });
          }
        }
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
    // Pad the check-name column to the widest name in *this* run so the detail
    // column stays aligned even when a long name (e.g. `slack.discovery`, 15) is
    // present (Issue #388). A fixed width mis-aligned those rows.
    const nameWidth = Math.max(...checks.map((c) => c.name.length));
    for (const c of checks) {
      this.context.stdout.write(`  [${label[c.status]}] ${c.name.padEnd(nameWidth)} ${c.detail}\n`);
    }
    const warnings = checks.filter((c) => c.status === "warn").length;
    const errors = checks.filter((c) => c.status === "error").length;
    this.context.stdout.write(`Summary: ${warnings} warning(s), ${errors} error(s)\n`);
    return hasError ? 1 : 0;
  }
}
