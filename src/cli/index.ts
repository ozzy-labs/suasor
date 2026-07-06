/**
 * CLI entry (clipanion). Commands are registered eagerly but their heavy work
 * is lazy-imported inside `execute` to keep cold start light (NFR-PRF-1).
 *
 * Wired command surface (docs/design/cli.md):
 *   init · onboard · db migrate · projections rebuild · search · source list/forget ·
 *   <connector> sync · sync · sync status ·
 *   <connector> auth set/test (github/ms-graph/google/box) ·
 *   <connector> discovery verbs (github repos; ADR-0030) · connectors list ·
 *   config show · config edit · validate-config · export backup ·
 *   embeddings status/rebuild/drain/find-duplicates · mcp serve · mcp tools ·
 *   slack auth set/test · slack conversations · slack status · slack cursor reset ·
 *   skills install/list/search/info
 * `init` / `db migrate` / `projections rebuild` / `search` / `<connector> sync` /
 * `mcp serve` (MCP read surface, ADR-0004) and `skills install` / `skills list`
 * (assistant-skill catalog, ADR-0008) are live. `<connector> sync` commands are
 * derived from the connector registry (one per connector, e.g. `github sync`;
 * ADR-0007).
 *
 * Registration is the only eager step. Command modules must keep their imports
 * to clipanion + the standard library so the registry stays cheap to build —
 * the DB layer, config loader, retrieval service, and connectors are imported
 * inside `execute`.
 */
import { Builtins, Cli, type CommandClass } from "clipanion";
import { VERSION } from "../version.ts";
import { BriefCommand } from "./commands/brief.ts";
import { ConfigEditCommand } from "./commands/config-edit.ts";
import { ConfigShowCommand } from "./commands/config-show.ts";
import { connectorAuthCommands } from "./commands/connector-auth.ts";
import { connectorDiscoveryCommands } from "./commands/connector-discovery.ts";
import { connectorSyncCommands } from "./commands/connector-sync.ts";
import { ConnectorsListCommand } from "./commands/connectors-list.ts";
import { DbMigrateCommand } from "./commands/db-migrate.ts";
import { DigestCommand } from "./commands/digest.ts";
import { DoctorCommand } from "./commands/doctor.ts";
import { embeddingsCommands } from "./commands/embeddings.ts";
import { ExportBackupCommand } from "./commands/export-backup.ts";
import { ExtractionListPendingCommand, ExtractionStatusCommand } from "./commands/extraction.ts";
import { InitCommand } from "./commands/init.ts";
import { McpServeCommand } from "./commands/mcp-serve.ts";
import { McpToolsCommand } from "./commands/mcp-tools.ts";
import { OnboardCommand } from "./commands/onboard.ts";
import { ProjectionsRebuildCommand } from "./commands/projections-rebuild.ts";
import { SearchCommand } from "./commands/search.ts";
import {
  SkillsInfoCommand,
  SkillsInstallCommand,
  SkillsListCommand,
  SkillsSearchCommand,
} from "./commands/skills.ts";
import {
  SlackAuthSetCommand,
  SlackAuthTestCommand,
  SlackConversationsCommand,
  SlackCursorBackfillCommand,
  SlackCursorResetCommand,
  SlackResolveNamesCommand,
  SlackStatusCommand,
} from "./commands/slack.ts";
import {
  SourceForgetCommand,
  SourceListCommand,
  SourceUnforgetCommand,
} from "./commands/source.ts";
import { StoreInfoCommand } from "./commands/store-info.ts";
import { SyncAllCommand, SyncStatusCommand } from "./commands/sync-all.ts";
import { ValidateConfigCommand } from "./commands/validate-config.ts";

/**
 * The full, ordered set of command classes the CLI registers. Kept as a single
 * list so the same registry drives both `buildCli()` (registration) and the
 * `categoryHelp()` interceptor (subcommand discovery) — the interceptor never
 * hand-maintains a verb list, so it cannot drift from what is actually wired.
 */
export function registeredCommandClasses(): CommandClass[] {
  return [
    Builtins.HelpCommand,
    Builtins.VersionCommand,
    InitCommand,
    OnboardCommand,
    DbMigrateCommand,
    ProjectionsRebuildCommand,
    SearchCommand,
    SourceListCommand,
    SourceForgetCommand,
    SourceUnforgetCommand,
    BriefCommand,
    DigestCommand,
    ...(connectorSyncCommands() as CommandClass[]),
    SyncAllCommand,
    SyncStatusCommand,
    ...(connectorAuthCommands() as CommandClass[]),
    ...(connectorDiscoveryCommands() as CommandClass[]),
    ConnectorsListCommand,
    ConfigShowCommand,
    ConfigEditCommand,
    ValidateConfigCommand,
    DoctorCommand,
    StoreInfoCommand,
    ExportBackupCommand,
    ExtractionStatusCommand,
    ExtractionListPendingCommand,
    ...(embeddingsCommands as CommandClass[]),
    McpServeCommand,
    McpToolsCommand,
    SlackAuthSetCommand,
    SlackAuthTestCommand,
    SlackConversationsCommand,
    SlackStatusCommand,
    SlackCursorResetCommand,
    SlackCursorBackfillCommand,
    SlackResolveNamesCommand,
    SkillsInstallCommand,
    SkillsListCommand,
    SkillsSearchCommand,
    SkillsInfoCommand,
  ] as CommandClass[];
}

/** Build the configured CLI instance. */
export function buildCli(commands: CommandClass[] = registeredCommandClasses()): Cli {
  const cli = new Cli({
    binaryLabel: "Suasor",
    binaryName: "suasor",
    binaryVersion: VERSION,
  });
  for (const command of commands) {
    cli.register(command);
  }
  return cli;
}

const HELP_FLAGS = new Set(["-h", "--help"]);

/**
 * Pre-parse interceptor for `suasor <category-verb> --help`.
 *
 * clipanion resolves a partial path like `slack` — the common prefix of several
 * commands — as an *ambiguous* selection and renders a "Multiple commands match
 * your selection" list with `-h=<index>` follow-up hints. That rendering lives
 * in clipanion's internal HelpCommand and is not reachable through the public
 * builder (see the #395 spike), and it reads as an error to anyone exploring
 * the CLI (e.g. the primary `slack` verb group).
 *
 * This interceptor recognises exactly that shape — a bare `--help`/`-h` whose
 * remaining tokens form a path *prefix* shared by 2+ registered commands yet is
 * not itself a complete command — and returns a plain, readable subcommand
 * listing instead. Every other shape is left for clipanion so its behaviour is
 * unchanged: the root `--help` (general help), a complete command's `--help`
 * (detailed help), and any invocation carrying other options all return `null`.
 *
 * The subcommand set is derived from the registry (static `paths` +
 * `usage.description`), never hand-maintained. The `#0` positional placeholder
 * called out in #395 is a separate clipanion-core limitation and is out of
 * scope here (this listing shows commands + summaries, not option usage).
 *
 * @returns the text to print (the caller then exits 0), or `null` to defer to
 * clipanion's own resolution.
 */
export function categoryHelp(
  argv: string[],
  commands: CommandClass[],
  binaryName: string,
): string | null {
  // Only a bare category `--help`: exactly one help flag and no other options.
  const helpFlags = argv.filter((token) => HELP_FLAGS.has(token));
  if (helpFlags.length !== 1) return null;
  const prefix: string[] = [];
  for (const token of argv) {
    if (HELP_FLAGS.has(token)) continue;
    // Any other option means this is a real command invocation → defer.
    if (token.startsWith("-")) return null;
    prefix.push(token);
  }
  // Root `--help` (no verb) stays clipanion's general help.
  if (prefix.length === 0) return null;

  const matchesPrefix = (segments: string[]): boolean =>
    segments.length > prefix.length && prefix.every((seg, i) => segments[i] === seg);
  const equalsPrefix = (segments: string[]): boolean =>
    segments.length === prefix.length && prefix.every((seg, i) => segments[i] === seg);

  const subcommands: { segments: string[]; description?: string }[] = [];
  for (const command of commands) {
    const description = command.usage?.description;
    for (const segments of command.paths ?? []) {
      // A complete command's own `--help` is clipanion's detailed help → defer.
      if (equalsPrefix(segments)) return null;
      if (matchesPrefix(segments)) subcommands.push({ segments, description });
    }
  }

  // Only intercept the genuinely ambiguous case: a prefix shared by ≥2 commands.
  // A single deeper command resolves uniquely and needs no interception.
  if (subcommands.length < 2) return null;

  return renderCategoryHelp(prefix, subcommands, binaryName);
}

/** Render the readable subcommand listing for a verb prefix. */
function renderCategoryHelp(
  prefix: string[],
  subcommands: { segments: string[]; description?: string }[],
  binaryName: string,
): string {
  const seen = new Set<string>();
  const rows: { command: string; description: string }[] = [];
  for (const { segments, description } of subcommands) {
    const command = [binaryName, ...segments].join(" ");
    if (seen.has(command)) continue;
    seen.add(command);
    rows.push({ command, description: (description ?? "").replace(/\s+/g, " ").trim() });
  }
  rows.sort((a, b) => a.command.localeCompare(b.command));

  const width = Math.max(...rows.map((row) => row.command.length));
  const verb = prefix.join(" ");
  const lines = [`Subcommands for \`${binaryName} ${verb}\`:`, ""];
  for (const { command, description } of rows) {
    lines.push(description ? `  ${command.padEnd(width)}  — ${description}` : `  ${command}`);
  }
  lines.push("");
  lines.push(
    `Run \`${binaryName} ${verb} <subcommand> --help\` for the details of a specific command.`,
  );
  lines.push("");
  return lines.join("\n");
}

/** Run the CLI against the given argv (defaults to process args). */
export async function runCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  const commands = registeredCommandClasses();
  const help = categoryHelp(argv, commands, "suasor");
  if (help !== null) {
    process.stdout.write(help);
    return 0;
  }
  const cli = buildCli(commands);
  return cli.run(argv, Cli.defaultContext);
}
