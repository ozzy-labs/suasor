/**
 * CLI entry (clipanion). Commands are registered eagerly but their heavy work
 * is lazy-imported inside `execute` to keep cold start light (NFR-PRF-1).
 *
 * This foundation Issue wires only `projections rebuild`; later Issues add
 * `init` / `db migrate` / `<connector> sync` / `search` / `mcp serve` /
 * `skills *` (docs/design/cli.md).
 */
import { Builtins, Cli } from "clipanion";
import { VERSION } from "../version.ts";
import { ProjectionsRebuildCommand } from "./commands/projections-rebuild.ts";

/** Build the configured CLI instance. */
export function buildCli(): Cli {
  const cli = new Cli({
    binaryLabel: "Suasor",
    binaryName: "suasor",
    binaryVersion: VERSION,
  });
  cli.register(Builtins.HelpCommand);
  cli.register(Builtins.VersionCommand);
  cli.register(ProjectionsRebuildCommand);
  return cli;
}

/** Run the CLI against the given argv (defaults to process args). */
export async function runCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  const cli = buildCli();
  return cli.run(argv, Cli.defaultContext);
}
