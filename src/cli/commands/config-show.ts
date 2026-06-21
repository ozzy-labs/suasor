/**
 * `suasor config show [--effective] [--json]` — print the effective config.
 *
 * `doctor` reports *health* ("what is wired vs. missing"); this verb reports the
 * resolved *values* — the result of merging `env override > file > defaults`
 * (the loader's precedence, src/config/loader.ts). It answers "what value is
 * actually in effect right now?" for CI / Docker / headless debugging, which
 * `doctor`'s status lines do not surface.
 *
 * Secrets are always masked (NFR-PRV-4): tokens never live in `config.toml`
 * (they sit in the OS keychain / an env override; src/connectors/secrets.ts), so
 * the merged config tree carries no secret values — but any secret-keyed value
 * is masked as defense-in-depth, and per-connector *credential presence* is
 * reported as a boolean only, never the value. `--effective` (default) prints
 * the merged values; the flag is explicit so a future `--source` can show
 * provenance without changing this default.
 *
 * Lazy-import discipline (NFR-PRF-1): the config loader and the secret resolver
 * are imported inside `execute`; only the cheap connector-name lookup is eager
 * (as in `doctor` / `connectors list`).
 */

import { Command, Option } from "clipanion";
import { connectorNames, connectorSecretNames } from "../../connectors/registry.ts";

/** A connector's credential presence (never the value, NFR-PRV-4). */
interface CredentialPresence {
  /** Secret name the connector reads (e.g. `token`, `clientSecret`). */
  secret: string;
  /** Whether a value is resolvable via env override or the OS keychain. */
  configured: boolean;
}

export class ConfigShowCommand extends Command {
  static override paths = [["config", "show"]];

  static override usage = Command.Usage({
    category: "Maintenance",
    description: "Print the effective configuration (merged values, secrets masked).",
    details: `
      Resolves and prints the effective config — the result of merging
      env override > file > defaults (the loader's precedence). Use it to confirm
      "what value is in effect right now?" in CI / Docker / headless setups, which
      \`doctor\` (health-only) does not show.

      Secrets are always masked (NFR-PRV-4): tokens are never stored in
      config.toml, and per-connector credential *presence* is reported as a
      boolean only — never the value. \`--effective\` (default) prints the merged
      values. Use --json for machine-readable output.
    `,
    examples: [
      ["Show the effective config", "suasor config show"],
      ["Machine-readable output", "suasor config show --json"],
    ],
  });

  effective = Option.Boolean("--effective", true, {
    description: "Print the merged effective values (default; reserved for future --source).",
  });

  json = Option.Boolean("--json", false, {
    description: "Emit the effective config as JSON instead of a human-readable report.",
  });

  override async execute(): Promise<number> {
    // `--effective` is the only mode today; it is an explicit (default-true) flag
    // reserving room for a future `--source` provenance view. `--no-effective`
    // has no alternative behaviour yet, so reject it instead of silently
    // ignoring the toggle (a silent no-op hides the unsupported request).
    if (!this.effective) {
      this.context.stderr.write(
        "config show: --no-effective is not supported yet (effective view is the only mode)\n",
      );
      return 1;
    }

    const [{ loadConfig, resolveConfigDir }, { maskSecrets }, { resolveSecret }, { join }] =
      await Promise.all([
        import("../../config/index.ts"),
        import("../../config/mask.ts"),
        import("../../connectors/secrets.ts"),
        import("node:path"),
      ]);

    let config: Awaited<ReturnType<typeof loadConfig>>;
    try {
      config = await loadConfig();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.context.stderr.write(`config show: failed to load config: ${message}\n`);
      return 1;
    }

    const configDir = resolveConfigDir();
    const configPath = join(configDir, "config.toml");

    // Mask any secret-keyed value defensively (tokens should not be here at all,
    // but never echo one if a user pasted it in against the contract).
    const masked = maskSecrets(config) as Record<string, unknown>;

    // Per-connector credential presence: probe only whether a value resolves
    // (env override or keychain), never read it (NFR-PRV-4).
    const credentials: Record<string, CredentialPresence[]> = {};
    for (const name of connectorNames()) {
      const secrets = connectorSecretNames(name);
      if (secrets.length === 0) continue; // needs no auth (e.g. web / local)
      const presence: CredentialPresence[] = [];
      for (const secret of secrets) {
        presence.push({ secret, configured: (await resolveSecret(name, secret)) !== null });
      }
      credentials[name] = presence;
    }

    if (this.json) {
      this.context.stdout.write(`${JSON.stringify({ config: masked, credentials }, null, 2)}\n`);
      return 0;
    }

    this.context.stdout.write("suasor config show (effective)\n");
    this.context.stdout.write(`  source: ${configPath}\n`);
    for (const line of renderLines(masked)) {
      this.context.stdout.write(`  ${line}\n`);
    }
    // Credential presence block: existence only, never the value.
    if (Object.keys(credentials).length > 0) {
      this.context.stdout.write("  credentials (presence only):\n");
      for (const [name, presence] of Object.entries(credentials)) {
        for (const { secret, configured } of presence) {
          const mark = configured ? "set" : "unset";
          this.context.stdout.write(`    connectors.${name}.${secret} = ${mark}\n`);
        }
      }
    }
    return 0;
  }
}

/**
 * Flatten a config object into sorted `dotted.path = value` lines for the
 * human-readable report. Arrays render as JSON; nested objects recurse.
 */
function renderLines(obj: Record<string, unknown>, prefix = ""): string[] {
  const lines: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    const path = prefix ? `${prefix}.${key}` : key;
    const value = obj[key];
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const nested = renderLines(value as Record<string, unknown>, path);
      if (nested.length === 0) lines.push(`${path} = {}`);
      else lines.push(...nested);
    } else {
      lines.push(`${path} = ${formatScalar(value)}`);
    }
  }
  return lines;
}

function formatScalar(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
