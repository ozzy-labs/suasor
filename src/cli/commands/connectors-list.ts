/**
 * `suasor connectors list [--json]` — introspect the connector registry
 * (ADR-0007, docs/design/cli.md). Lists every registered connector with its
 * `enabled` state (from `[connectors.<name>]` config) and whether its
 * credential is configured — **without** ever printing the secret value
 * (NFR-PRV-4).
 *
 * A connector is `enabled` when a `[connectors.<name>]` slice exists and does
 * not set `enabled = false`; an absent slice reports `enabled = false`. Token
 * presence is resolved through `resolveSecret` (env override → OS keychain), the
 * same precedence ingest uses, so the report reflects what a real sync would
 * see. Connectors that need no auth (e.g. `web`) report `tokenConfigured = null`.
 *
 * Lazy-import discipline (NFR-PRF-1): the registry's name/secret lookup is cheap
 * (loads no SDK), so building the command set at registration stays light; the
 * config loader and keychain are imported inside `execute`.
 */
import { Command, Option } from "clipanion";
import { connectorNames, connectorSecretNames } from "../../connectors/registry.ts";

/** One connector's introspected state (shape of each `--json` array element). */
interface ConnectorStatus {
  /** Connector name / CLI verb (e.g. "github"). */
  name: string;
  /** `[connectors.<name>]` present and not `enabled = false`. */
  enabled: boolean;
  /**
   * Whether the connector's credential is configured (env override or keychain),
   * or `null` for connectors that need no auth (e.g. `web`). Never the value.
   */
  tokenConfigured: boolean | null;
}

export class ConnectorsListCommand extends Command {
  static override paths = [["connectors", "list"]];

  static override usage = Command.Usage({
    category: "Connectors",
    description: "List registered connectors with enabled + credential status.",
    details: `
      Introspects the connector registry (ADR-0007): every registered connector,
      whether it is enabled in config ([connectors.<name>], default off when no
      slice exists), and whether its credential is configured (env override or OS
      keychain — the value is never printed, NFR-PRV-4). Connectors needing no
      auth (e.g. web) show token status "n/a". Use --json for machine output.
    `,
    examples: [
      ["List connectors and their status", "suasor connectors list"],
      ["Machine-readable output", "suasor connectors list --json"],
    ],
  });

  json = Option.Boolean("--json", false, {
    description: "Emit the connector status list as JSON.",
  });

  override async execute(): Promise<number> {
    const [{ loadConfig }, { resolveSecret }] = await Promise.all([
      import("../../config/index.ts"),
      import("../../connectors/secrets.ts"),
    ]);

    const config = await loadConfig();

    const statuses: ConnectorStatus[] = [];
    for (const name of connectorNames()) {
      const slice = config.connectors[name];
      // enabled: slice present and not explicitly `enabled = false`.
      const enabled = slice !== undefined && slice.enabled !== false;

      const secretNames = connectorSecretNames(name);
      let tokenConfigured: boolean | null;
      if (secretNames.length === 0) {
        tokenConfigured = null; // connector needs no auth (e.g. web)
      } else {
        // Configured when *every* required secret resolves to a non-empty value.
        let allPresent = true;
        for (const secret of secretNames) {
          const value = await resolveSecret(name, secret);
          if (value === null) {
            allPresent = false;
            break;
          }
        }
        tokenConfigured = allPresent;
      }

      statuses.push({ name, enabled, tokenConfigured });
    }

    if (this.json) {
      this.context.stdout.write(`${JSON.stringify(statuses, null, 2)}\n`);
      return 0;
    }

    for (const s of statuses) {
      const enabledLabel = s.enabled ? "enabled " : "disabled";
      const tokenLabel =
        s.tokenConfigured === null ? "n/a" : s.tokenConfigured ? "configured" : "missing";
      this.context.stdout.write(`${s.name.padEnd(9)} ${enabledLabel}  token: ${tokenLabel}\n`);
    }
    const enabledCount = statuses.filter((s) => s.enabled).length;
    this.context.stdout.write(`${statuses.length} connector(s), ${enabledCount} enabled.\n`);
    return 0;
  }
}
