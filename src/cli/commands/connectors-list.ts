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
import { connectorNames } from "../../connectors/registry.ts";
import { SuasorCommand } from "../base-command.ts";

/** One connector's introspected state (shape of each `--json` array element). */
interface ConnectorStatus {
  /** Connector name / CLI verb (e.g. "github"). */
  name: string;
  /** `[connectors.<name>]` present and not `enabled = false`. */
  enabled: boolean;
  /**
   * Whether the connector's credential is configured (env override or keychain),
   * or `null` for connectors that need no auth (e.g. `web`). Never the value.
   * For a multi-account connector this is true only when **every** configured
   * account has one — a single stored credential must not report the connector
   * as ready while a second account silently syncs nothing (ADR-0050).
   */
  tokenConfigured: boolean | null;
  /**
   * Declared accounts missing a credential (ADR-0050). Absent for a
   * single-account connector, so the pre-ADR-0050 shape is unchanged.
   */
  missingAccounts?: string[];
}

export class ConnectorsListCommand extends SuasorCommand {
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
    const [{ loadConfig }, { resolveSecret }, { accountSecretProbes }] = await Promise.all([
      import("../../config/index.ts"),
      import("../../connectors/secrets.ts"),
      import("../../connectors/noop-check.ts"),
    ]);

    const config = await loadConfig();

    const statuses: ConnectorStatus[] = [];
    for (const name of connectorNames()) {
      const slice = config.connectors[name];
      // enabled: slice present and not explicitly `enabled = false`.
      const enabled = slice !== undefined && slice.enabled !== false;

      // One probe per (account, secret) — for a single-account connector that is
      // exactly its declared secret names (ADR-0050).
      const probes = accountSecretProbes(name, slice ?? {});
      let tokenConfigured: boolean | null;
      const missingAccounts: string[] = [];
      if (probes.length === 0) {
        tokenConfigured = null; // connector needs no auth (e.g. web)
      } else {
        // Configured when *every* required secret resolves to a non-empty value.
        // Every probe runs: which accounts are missing is the actionable part,
        // and stopping at the first would name only one of them.
        let allPresent = true;
        for (const probe of probes) {
          if ((await resolveSecret(name, probe.secret)) !== null) continue;
          allPresent = false;
          if (probe.account !== null && !missingAccounts.includes(probe.account)) {
            missingAccounts.push(probe.account);
          }
        }
        tokenConfigured = allPresent;
      }

      statuses.push({
        name,
        enabled,
        tokenConfigured,
        ...(missingAccounts.length > 0 ? { missingAccounts } : {}),
      });
    }

    if (this.json) {
      this.context.stdout.write(`${JSON.stringify(statuses, null, 2)}\n`);
      return 0;
    }

    for (const s of statuses) {
      const enabledLabel = s.enabled ? "enabled " : "disabled";
      const tokenLabel =
        s.tokenConfigured === null ? "n/a" : s.tokenConfigured ? "configured" : "missing";
      // Naming the accounts turns "missing" from a puzzle into an instruction.
      const accounts =
        s.missingAccounts && s.missingAccounts.length > 0
          ? ` (accounts: ${s.missingAccounts.join(", ")})`
          : "";
      this.context.stdout.write(
        `${s.name.padEnd(9)} ${enabledLabel}  token: ${tokenLabel}${accounts}\n`,
      );
    }
    const enabledCount = statuses.filter((s) => s.enabled).length;
    this.context.stdout.write(`${statuses.length} connector(s), ${enabledCount} enabled.\n`);
    return 0;
  }
}
