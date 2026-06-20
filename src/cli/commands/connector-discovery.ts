/**
 * `suasor <connector> <verb>` discovery commands (ADR-0030; generalizes Slack's
 * `slack conversations` id-discovery to other connectors). One discovery command
 * is registered per connector that declares a spec in
 * {@link import("../../connectors/discovery-specs.ts").DISCOVERY_SPECS} — the
 * first being `suasor github repos`.
 *
 * A discovery verb enumerates the ids a token can see and prints a paste-ready
 * `[connectors.<name>]` block, so the operator never hand-hunts an id (a typo
 * silently ingests nothing — ADR-0007 "no silent wrong answer"). The generic
 * connector contract stays `sync`-only (ADR-0007); discovery is a connector verb.
 *
 * Lazy-import discipline (NFR-PRF-1): top-level imports are clipanion + the
 * discovery spec **names** only (a cheap list, loads no SDK). The keychain
 * (`secrets.ts`), the config loader, and the per-connector `fetch`-only
 * discovery leaves are imported inside `execute`. No connector SDK is pulled.
 */
import { Command, type CommandClass, Option } from "clipanion";
import {
  type ConnectorDiscoverySpec,
  DISCOVERY_SPECS,
  discoveryConnectorNames,
} from "../../connectors/discovery-specs.ts";

/** Base class for `<connector> <verb>` — enumerates ids + prints a config block. */
class ConnectorDiscoveryCommand extends Command {
  static connectorName = "";
  static discoveryVerb = "";

  filter = Option.String("--filter", {
    description: "Filter items by a case-insensitive substring match.",
  });
  json = Option.Boolean("--json", false, { description: "Emit the result as JSON." });
  noProgress = Option.Boolean("--no-progress", false, {
    description: "Disable the progress indicator (auto-off when stderr is not a TTY).",
  });

  override async execute(): Promise<number> {
    const connector = (this.constructor as typeof ConnectorDiscoveryCommand).connectorName;
    const { DISCOVERY_SPECS } = await import("../../connectors/discovery-specs.ts");
    const spec: ConnectorDiscoverySpec | undefined = DISCOVERY_SPECS[connector];
    if (!spec) {
      this.context.stderr.write(`error: no discovery spec for connector '${connector}'\n`);
      return 1;
    }

    const [{ loadConfig }, { makeSecretResolver }, { createProgress }] = await Promise.all([
      import("../../config/index.ts"),
      import("../../connectors/secrets.ts"),
      import("../progress.ts"),
    ]);
    const config = await loadConfig();
    const slice = (config.connectors[connector] ?? {}) as Record<string, unknown>;
    const secret = makeSecretResolver(connector);

    // Indeterminate progress on stderr while paging runs, so a multi-page sweep
    // is not silent. TTY-gated and suppressed by --no-progress so --json / piped
    // output stays clean (#84; same pattern as slack conversations).
    const progress = createProgress(
      this.context.stderr,
      `${connector} ${spec.verb}`,
      this.noProgress ? false : undefined,
    );

    let result: Awaited<ReturnType<typeof spec.discover>>;
    try {
      result = await spec.discover({
        secret,
        config: slice,
        ...(this.filter ? { filter: this.filter } : {}),
        onProgress: () => progress.tick(),
      });
    } catch (cause) {
      progress.finish();
      const message = cause instanceof Error ? cause.message : String(cause);
      const hint = message.startsWith(`no ${connector} `)
        ? ` (run \`suasor ${connector} auth set\` or set the env override)`
        : "";
      this.context.stderr.write(`error: ${message}${hint}\n`);
      return 1;
    }
    progress.finish();

    if (this.json) {
      this.context.stdout.write(
        `${JSON.stringify({ items: result.items, configBlock: result.configBlock }, null, 2)}\n`,
      );
      return 0;
    }

    this.context.stdout.write(
      `${result.items.length} ${spec.itemNoun}(s) visible to this token:\n`,
    );
    for (const item of result.items) {
      this.context.stdout.write(`  ${item.value}  (${item.label})\n`);
    }
    this.context.stdout.write("\n");
    for (const line of result.configBlock) {
      this.context.stdout.write(`${line}\n`);
    }
    this.context.stderr.write(
      `next: paste the block above into config.toml, then run \`suasor ${connector} sync\`.\n`,
    );
    return 0;
  }
}

/** Build the `<connector> <verb>` discovery command for one connector. */
function makeDiscoveryCommand(spec: ConnectorDiscoverySpec): CommandClass {
  const Sub = class extends ConnectorDiscoveryCommand {
    static override paths = [[spec.connector, spec.verb]];
    static override connectorName = spec.connector;
    static override discoveryVerb = spec.verb;
    static override usage = Command.Usage({
      category: "Connector discovery",
      description: spec.summary,
      details: `
        Enumerates the ${spec.itemNoun}s the stored ${spec.connector} credential
        can see (read-only), then prints a [connectors.${spec.connector}] block you
        can paste into config.toml so you never hand-hunt an id — a mistyped id
        silently ingests nothing (ADR-0030). Use --filter to narrow a long list,
        --json for machine-readable output. The credential never touches stderr.
      `,
      examples: [
        [`List everything visible`, `suasor ${spec.connector} ${spec.verb}`],
        [`Filtered, as JSON`, `suasor ${spec.connector} ${spec.verb} --filter acme --json`],
      ],
    });
  };
  Object.defineProperty(Sub, "name", {
    value: `${spec.connector}${spec.verb}DiscoveryCommand`,
  });
  return Sub;
}

/** Every connector's discovery command (cheap: loads no SDK). */
export function connectorDiscoveryCommands(): CommandClass[] {
  const commands: CommandClass[] = [];
  for (const name of discoveryConnectorNames()) {
    const spec = DISCOVERY_SPECS[name];
    if (spec) commands.push(makeDiscoveryCommand(spec));
  }
  return commands;
}
