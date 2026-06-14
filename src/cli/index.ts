/**
 * CLI entry (clipanion). Commands are registered eagerly but their heavy work
 * is lazy-imported inside `execute` to keep cold start light (NFR-PRF-1).
 *
 * Wired command surface (docs/design/cli.md):
 *   init · db migrate · projections rebuild · search · <connector> sync ·
 *   mcp serve · skills install · skills list
 * `init` / `db migrate` / `projections rebuild` / `search` / `<connector> sync`
 * are live; `mcp serve` and `skills *` are downstream stubs (the MCP surface —
 * ADR-0004 — and the assistant-skill catalog — ADR-0008 — are implemented by
 * later Issues). `<connector> sync` commands are derived from the connector
 * registry (one per connector, e.g. `github sync`; ADR-0007).
 *
 * Registration is the only eager step. Command modules must keep their imports
 * to clipanion + the standard library so the registry stays cheap to build —
 * the DB layer, config loader, retrieval service, and connectors are imported
 * inside `execute`.
 */
import { Builtins, Cli, type CommandClass } from "clipanion";
import { VERSION } from "../version.ts";
import { connectorSyncCommands } from "./commands/connector-sync.ts";
import { DbMigrateCommand } from "./commands/db-migrate.ts";
import { InitCommand } from "./commands/init.ts";
import { McpServeCommand } from "./commands/mcp-serve.ts";
import { ProjectionsRebuildCommand } from "./commands/projections-rebuild.ts";
import { SearchCommand } from "./commands/search.ts";
import { SkillsInstallCommand, SkillsListCommand } from "./commands/skills.ts";

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
  for (const ConnectorSync of connectorSyncCommands() as CommandClass[]) {
    cli.register(ConnectorSync);
  }
  cli.register(McpServeCommand);
  cli.register(SkillsInstallCommand);
  cli.register(SkillsListCommand);
  return cli;
}

/** Run the CLI against the given argv (defaults to process args). */
export async function runCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  const cli = buildCli();
  return cli.run(argv, Cli.defaultContext);
}
