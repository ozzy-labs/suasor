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
  type DiscoveryItem,
  type DiscoveryScope,
  discoveryConnectorNames,
} from "../../connectors/discovery-specs.ts";

/** Base class for `<connector> <verb>` — enumerates ids + prints a config block. */
class ConnectorDiscoveryCommand extends Command {
  static connectorName = "";
  static discoveryVerb = "";

  filter = Option.String("--filter", {
    description: "Filter items by a case-insensitive substring match.",
  });
  root = Option.String("--root", {
    description: "Root node id to enumerate under (tree-shaped namespaces only, e.g. box folders).",
  });
  json = Option.Boolean("--json", false, { description: "Emit the result as JSON." });
  new = Option.Boolean("--new", false, {
    description:
      "Show only what is visible to the credential but missing from config (drift), plus what config lists that is no longer visible.",
  });
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

    // `--root` only applies to tree-shaped namespaces (e.g. box folders); reject
    // it for flat ones so a typo never silently does nothing.
    if (this.root !== undefined && !spec.acceptsRoot) {
      this.context.stderr.write(`error: \`${connector} ${spec.verb}\` does not accept --root\n`);
      return 1;
    }

    // `--new` needs a configured *set* of ids to diff against. A connector whose
    // scope is a single value says why instead of emitting a diff in which every
    // non-selected item looks like drift (ADR-0049).
    if (this.new && !spec.scope) {
      this.context.stderr.write(
        `error: \`${connector} ${spec.verb} --new\` is not available: ` +
          `${spec.driftNote ?? "this connector's ingest scope is not a set of ids"}\n`,
      );
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
        ...(this.root ? { root: this.root } : {}),
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

    if (this.new && spec.scope) {
      return this.reportDrift(connector, spec, spec.scope, slice, result.items);
    }

    if (this.json) {
      this.context.stdout.write(
        `${JSON.stringify({ items: result.items, configBlock: result.configBlock }, null, 2)}\n`,
      );
      return 0;
    }

    this.context.stdout.write(
      `${result.items.length} ${spec.itemNoun}(s) visible to this token:\n`,
    );
    // A tree-shaped namespace (box folders) supplies a pre-rendered indented
    // listing; flat namespaces fall back to the generic `value (label)` lines.
    if (result.listing) {
      for (const line of result.listing) {
        this.context.stdout.write(`  ${line}\n`);
      }
    } else {
      for (const item of result.items) {
        this.context.stdout.write(`  ${item.value}  (${item.label})\n`);
      }
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

  /**
   * Render the drift view (`--new`, ADR-0049): only what the credential can see
   * that config does not list, plus what config lists that the enumeration no
   * longer returns. Nothing is ingested and nothing is written to config —
   * explicit enumeration stays the model (ADR-0039 §Decision), this only removes
   * the "re-read the whole list and eyeball it" step.
   *
   * Exit code stays 0 even when drift exists: it is information, not a failure
   * (a repo you deliberately do not ingest is not an error). `doctor` is where a
   * gating verdict belongs.
   */
  private async reportDrift(
    connector: string,
    spec: ConnectorDiscoverySpec,
    scope: DiscoveryScope,
    slice: Record<string, unknown>,
    items: readonly DiscoveryItem[],
  ): Promise<number> {
    const { configuredIds, diffDiscovered } = await import("../../connectors/discovery-specs.ts");
    // A narrowed enumeration cannot support a "removed" claim — see DiscoveryDiff.
    const partialView = this.filter !== undefined || this.root !== undefined;
    const configured = configuredIds(slice, scope);
    const diff = diffDiscovered(items, configured, scope, partialView);

    if (this.json) {
      this.context.stdout.write(
        `${JSON.stringify(
          {
            new: diff.added,
            removed: diff.removed,
            removedComputed: diff.removedComputed,
          },
          null,
          2,
        )}\n`,
      );
      return 0;
    }

    if (diff.added.length === 0) {
      this.context.stdout.write(
        `no new ${spec.itemNoun}(s): every ${spec.itemNoun} visible to this credential is already in [connectors.${connector}].${scope.key}\n`,
      );
    } else {
      this.context.stdout.write(
        `${diff.added.length} new ${spec.itemNoun}(s) visible but not in config:\n`,
      );
      for (const item of diff.added) {
        this.context.stdout.write(`  ${item.value}  (${item.label})\n`);
      }
      this.context.stdout.write("\n");
      const { renderConnectorConfigBlock } = await import(
        "../../connectors/onboard/config-block.ts"
      );
      const block = renderConnectorConfigBlock(
        connector,
        diff.added.map((item) => ({ value: item.value, label: item.label })),
        { key: scope.key, idNote: scope.idNote },
      );
      for (const line of block) this.context.stdout.write(`${line}\n`);
      this.context.stderr.write(
        `next: merge the ids above into the existing [connectors.${connector}].${scope.key} list ` +
          `(nothing was ingested or written), then run \`suasor ${connector} sync\`.\n`,
      );
    }

    if (!diff.removedComputed) {
      // Say so rather than print an empty "removed" section that reads as "none".
      this.context.stdout.write(
        "\nremoved: not checked (--filter / --root narrows the view, so an id that is out of view is indistinguishable from one that is gone)\n",
      );
    } else if (diff.removed.length > 0) {
      this.context.stdout.write(
        `\n${diff.removed.length} configured ${spec.itemNoun}(s) not visible to this credential ` +
          "(renamed, deleted, or no longer permitted — they sync nothing):\n",
      );
      for (const id of diff.removed) this.context.stdout.write(`  ${id}\n`);
    }
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
        ${
          spec.scope
            ? `Use --new to see only the drift: the ${spec.itemNoun}s visible to the
        credential that [connectors.${spec.connector}].${spec.scope.key} does not
        list (and, on an unnarrowed run, the configured ids that are no longer
        visible). Nothing is ingested or written to config — explicit enumeration
        stays the model (ADR-0039 / ADR-0049).`
            : `--new is not available here: ${spec.driftNote ?? ""}`
        }
      `,
      examples: [
        [`List everything visible`, `suasor ${spec.connector} ${spec.verb}`],
        [`Filtered, as JSON`, `suasor ${spec.connector} ${spec.verb} --filter acme --json`],
        ...(spec.scope
          ? ([[`Only what config is missing`, `suasor ${spec.connector} ${spec.verb} --new`]] as [
              string,
              string,
            ][])
          : []),
        ...(spec.acceptsRoot
          ? ([
              [
                `Enumerate under a specific root`,
                `suasor ${spec.connector} ${spec.verb} --root 12345`,
              ],
            ] as [string, string][])
          : []),
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
