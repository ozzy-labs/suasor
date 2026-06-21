/**
 * `suasor config edit [--editor <cmd>]` — open config.toml in an editor and
 * validate on save, rolling back on a bad edit (Issue #280).
 *
 * `onboard` is for *adding* a connector; `config show` only *displays*. This
 * verb is the micro-edit path: open the existing `config.toml` in `$EDITOR` (or
 * `--editor`), then after the editor exits re-validate the file with the same
 * loader the runtime uses (schema + strict connector slices, ADR-0007). If the
 * edit produced invalid TOML or a schema violation, the original file is
 * restored and the command exits non-zero so a broken config is never left
 * behind.
 *
 * This is a write verb (mutates config.toml), but it is human-in-the-loop by
 * construction — the user types the change in their editor; nothing is applied
 * autonomously (ADR-0004). Secrets are never written here (tokens live in the
 * keychain; the config carries none — NFR-PRV-4) and the file is not echoed.
 *
 * Lazy-import discipline (NFR-PRF-1): the config loader is imported inside
 * `execute`; only clipanion + node:fs/path/child_process are eager (std lib).
 */
import { Command, Option } from "clipanion";

export class ConfigEditCommand extends Command {
  static override paths = [["config", "edit"]];

  static override usage = Command.Usage({
    category: "Maintenance",
    description: "Open config.toml in your editor and validate on save (rolls back a bad edit).",
    details: `
      Opens the existing config.toml in $EDITOR (or --editor <cmd>) for a
      micro-edit, then re-validates it with the same loader the runtime uses
      (schema + strict per-connector slices, ADR-0007). If the saved file is
      invalid TOML or violates the schema, the original is restored and the
      command exits non-zero — so a broken config is never left in place.

      Complements \`onboard\` (adds a connector) and \`config show\` (displays
      the effective config). Human-in-the-loop by construction (ADR-0004): you
      type the change; nothing is applied autonomously. Secrets are never written
      here (tokens live in the OS keychain, not the config — NFR-PRV-4).
    `,
    examples: [
      ["Edit with $EDITOR", "suasor config edit"],
      ["Edit with a specific editor", "suasor config edit --editor nano"],
    ],
  });

  editor = Option.String("--editor", {
    description: "Editor command to launch (default: $EDITOR, then $VISUAL).",
  });

  /**
   * Injectable editor runner (tests substitute a deterministic mutation instead
   * of spawning a real editor). Returns the editor's exit code. Not a CLI flag.
   */
  runEditor: (command: string, args: string[]) => Promise<number> = async (command, args) => {
    const { spawn } = await import("node:child_process");
    return new Promise<number>((resolve, reject) => {
      const child = spawn(command, args, { stdio: "inherit" });
      child.on("error", reject);
      child.on("exit", (code) => resolve(code ?? 0));
    });
  };

  override async execute(): Promise<number> {
    const [{ loadConfig, resolveConfigDir }, { join }, fs] = await Promise.all([
      import("../../config/index.ts"),
      import("node:path"),
      import("node:fs/promises"),
    ]);

    const configDir = resolveConfigDir();
    const configPath = join(configDir, "config.toml");

    // Require the file to exist — editing a non-existent config is `init`'s job.
    let original: string;
    try {
      original = await fs.readFile(configPath, "utf8");
    } catch {
      this.context.stderr.write(
        `error: no config.toml at ${configPath} (run \`suasor init\` first)\n`,
      );
      return 1;
    }

    const editorCmd = this.editor ?? process.env.EDITOR ?? process.env.VISUAL;
    if (!editorCmd || editorCmd.trim().length === 0) {
      this.context.stderr.write(
        "error: no editor configured (set $EDITOR or pass --editor <cmd>)\n",
      );
      return 1;
    }

    // Allow `--editor "code --wait"` style commands by splitting on whitespace.
    const [bin, ...editorArgs] = editorCmd.trim().split(/\s+/);
    const exitCode = await this.runEditor(bin as string, [...editorArgs, configPath]);
    if (exitCode !== 0) {
      this.context.stderr.write(
        `error: editor exited with code ${exitCode}; no changes validated\n`,
      );
      return 1;
    }

    const edited = await fs.readFile(configPath, "utf8");
    if (edited === original) {
      this.context.stdout.write("no changes.\n");
      return 0;
    }

    // Validate the edited file with the real loader (TOML parse + schema + strict
    // connector slices). On failure, restore the original so a broken config is
    // never left behind, and surface the structured issues to the user.
    try {
      await loadConfig({ configDir });
    } catch (err) {
      await fs.writeFile(configPath, original, "utf8");
      const message = err instanceof Error ? err.message : String(err);
      this.context.stderr.write(`error: edited config is invalid; reverted.\n  ${message}\n`);
      this.context.stderr.write("(your edit was rolled back — re-run to try again)\n");
      return 1;
    }

    this.context.stdout.write(`config saved and validated: ${configPath}\n`);
    return 0;
  }
}
