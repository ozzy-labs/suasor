/**
 * CLI entry (clipanion). Commands are registered eagerly but their heavy work
 * is lazy-imported inside `execute` to keep cold start light (NFR-PRF-1).
 *
 * Wired command surface (docs/design/cli.md):
 *   init · db migrate · projections rebuild · search · <connector> sync ·
 *   <connector> auth set/test (github/ms-graph/google/box) · connectors list ·
 *   embeddings status/rebuild/drain/find-duplicates · mcp serve · mcp tools ·
 *   slack auth set/test · slack conversations · slack status · slack cursor reset ·
 *   skills install/list
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
import { connectorAuthCommands } from "./commands/connector-auth.ts";
import { connectorSyncCommands } from "./commands/connector-sync.ts";
import { ConnectorsListCommand } from "./commands/connectors-list.ts";
import { DbMigrateCommand } from "./commands/db-migrate.ts";
import { DoctorCommand } from "./commands/doctor.ts";
import { embeddingsCommands } from "./commands/embeddings.ts";
import { InitCommand } from "./commands/init.ts";
import { McpServeCommand } from "./commands/mcp-serve.ts";
import { McpToolsCommand } from "./commands/mcp-tools.ts";
import { ProjectionsRebuildCommand } from "./commands/projections-rebuild.ts";
import { SearchCommand } from "./commands/search.ts";
import { SkillsInstallCommand, SkillsListCommand } from "./commands/skills.ts";
import {
  SlackAuthSetCommand,
  SlackAuthTestCommand,
  SlackConversationsCommand,
  SlackCursorBackfillCommand,
  SlackCursorResetCommand,
  SlackStatusCommand,
} from "./commands/slack.ts";

/** Build the configured CLI instance. */
export function buildCli(): Cli {
  const cli = new Cli({
    binaryLabel: "Suasor",
    binaryName: "suasor",
    binaryVersion: VERSION,
  });
  cli.register(Builtins.HelpCommand);
  cli.register(Builtins.VersionCommand);
  cli.register(InitCommand);
  cli.register(DbMigrateCommand);
  cli.register(ProjectionsRebuildCommand);
  cli.register(SearchCommand);
  cli.register(BriefCommand);
  for (const ConnectorSync of connectorSyncCommands() as CommandClass[]) {
    cli.register(ConnectorSync);
  }
  for (const ConnectorAuth of connectorAuthCommands() as CommandClass[]) {
    cli.register(ConnectorAuth);
  }
  cli.register(ConnectorsListCommand);
  cli.register(DoctorCommand);
  for (const EmbeddingsCommand of embeddingsCommands as CommandClass[]) {
    cli.register(EmbeddingsCommand);
  }
  cli.register(McpServeCommand);
  cli.register(McpToolsCommand);
  cli.register(SlackAuthSetCommand);
  cli.register(SlackAuthTestCommand);
  cli.register(SlackConversationsCommand);
  cli.register(SlackStatusCommand);
  cli.register(SlackCursorResetCommand);
  cli.register(SlackCursorBackfillCommand);
  cli.register(SkillsInstallCommand);
  cli.register(SkillsListCommand);
  return cli;
}

/** Run the CLI against the given argv (defaults to process args). */
export async function runCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  const cli = buildCli();
  return cli.run(argv, Cli.defaultContext);
}
