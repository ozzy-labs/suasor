/**
 * Shared base class for every registered CLI command (#560).
 *
 * `loadConfig()` fails fast with a `ConfigError` when config.toml is invalid —
 * the single most common user mistake (a bad hand-edit). Previously only the
 * sync commands caught it; every other command let it escape to clipanion's
 * internal-error rendering, turning a routine `search` / `brief` / `sync
 * status` into a developer-style crash dump with raw stack frames.
 *
 * Catching it centrally here gives every command the same clean failure:
 * `error: <message>` plus a `hint:` pointing at `suasor config validate`,
 * written to stderr with exit code 1. Commands that need a different policy
 * (e.g. `validate-config` itself, or auth commands that tolerate a broken
 * config) still catch `ConfigError` closer to the call site — this base class
 * only handles what would otherwise escape.
 *
 * The config module is imported lazily inside the error path so building the
 * CLI registry stays light (NFR-PRF-1, docs/design/cli.md).
 */
import { Command } from "clipanion";

export abstract class SuasorCommand extends Command {
  override async validateAndExecute(): Promise<number> {
    try {
      return await super.validateAndExecute();
    } catch (error) {
      // Lazy import: this path only runs when a command already failed, so the
      // config loader never contributes to registry cold start.
      const { ConfigError } = await import("../config/error.ts");
      if (error instanceof ConfigError) {
        this.context.stderr.write(
          `error: ${error.message}\nhint: run \`suasor config validate\`\n`,
        );
        return 1;
      }
      throw error;
    }
  }
}
