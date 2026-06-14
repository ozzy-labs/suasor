/**
 * `suasor skills install [--scope]` / `suasor skills list` — assistant skills.
 *
 * Stubs: the assistant-skill catalog (SSOT `docs/skills/<name>/SKILL.md`) and
 * the install/expand mechanism are implemented by a downstream Issue
 * (ADR-0008). These commands are wired into the CLI now so the command surface
 * is stable; they print a pending notice and exit without side effects.
 *
 * `--scope` selects the install target (`claude` → `.claude/skills/`, `agents`
 * → `.agents/skills/`, `all` → both). The flag is parsed now so the surface is
 * fixed even though expansion is not yet implemented.
 */
import { Command, Option } from "clipanion";

/** Install targets for assistant skills (ADR-0008). */
const SCOPES = ["claude", "agents", "all"] as const;
type Scope = (typeof SCOPES)[number];

export class SkillsInstallCommand extends Command {
  static override paths = [["skills", "install"]];

  static override usage = Command.Usage({
    category: "Skills",
    description: "Expand bundled assistant skills into agent skill dirs (not yet implemented).",
    details: `
      Will expand the bundled assistant skills (SSOT docs/skills/<name>/SKILL.md)
      into .claude/skills/ and/or .agents/skills/ (ADR-0008). Wired by a
      downstream Issue; currently a stub.
    `,
    examples: [
      ["Install to all agent dirs", "suasor skills install"],
      ["Install only for Claude Code", "suasor skills install --scope claude"],
    ],
  });

  scope = Option.String("--scope", "all", {
    description: "Install target: claude | agents | all (default all).",
  });

  override async execute(): Promise<number> {
    if (!SCOPES.includes(this.scope as Scope)) {
      this.context.stderr.write(
        `error: invalid --scope '${this.scope}' (expected: ${SCOPES.join(" | ")})\n`,
      );
      return 1;
    }
    this.context.stderr.write(
      `suasor skills install: not yet implemented (scope=${this.scope}; wired by a later Issue, ADR-0008).\n`,
    );
    return 0;
  }
}

export class SkillsListCommand extends Command {
  static override paths = [["skills", "list"]];

  static override usage = Command.Usage({
    category: "Skills",
    description: "List bundled assistant skills (not yet implemented).",
    details: `
      Will list the bundled assistant skills and their installed status
      (ADR-0008). Wired by a downstream Issue; currently a stub.
    `,
    examples: [["List bundled skills", "suasor skills list"]],
  });

  override async execute(): Promise<number> {
    this.context.stderr.write(
      "suasor skills list: not yet implemented (wired by a later Issue, ADR-0008).\n",
    );
    return 0;
  }
}
