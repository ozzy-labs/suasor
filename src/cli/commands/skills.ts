/**
 * `suasor skills install` / `suasor skills list` — assistant skills (ADR-0008).
 *
 * The SSOT for each assistant skill is `docs/skills/<name>/SKILL.md`, shipped
 * with the package. `install` expands those into the agent skill dirs
 * (`.claude/skills/` / `.agents/skills/`); `list` reports their installed
 * status. Only the bundled assistant skills are touched — ecosystem dev skills
 * (`@ozzylabs/skills`) live in a disjoint namespace.
 *
 * Flags:
 *   --scope claude|agents|all   which mirror dir(s) to target (default all)
 *   --host  <dir>               base dir to install under (default cwd)
 *   --dry-run                   (install) preview without writing
 *   --json                      (list) machine-readable status
 *
 * The skills service (fs work) is lazy-imported inside `execute` to keep the
 * command registry cheap to build (NFR-PRF-1, docs/design/cli.md).
 */
import { Command, Option } from "clipanion";

/** Install targets for assistant skills (ADR-0008). Mirrors `skills` module. */
const SCOPES = ["claude", "agents", "all"] as const;
type Scope = (typeof SCOPES)[number];

export class SkillsInstallCommand extends Command {
  static override paths = [["skills", "install"]];

  static override usage = Command.Usage({
    category: "Skills",
    description: "Expand bundled assistant skills into agent skill dirs.",
    details: `
      Expands the bundled assistant skills (SSOT docs/skills/<name>/SKILL.md)
      into .claude/skills/ and/or .agents/skills/ (ADR-0008). Idempotent:
      unchanged skills are left as-is, drifted ones are refreshed from the SSOT.
    `,
    examples: [
      ["Install to all agent dirs in the current project", "suasor skills install"],
      ["Install only for Claude Code", "suasor skills install --scope claude"],
      ["Preview without writing", "suasor skills install --dry-run"],
      ["Install into a specific project root", "suasor skills install --host /path/to/project"],
    ],
  });

  scope = Option.String("--scope", "all", {
    description: "Install target: claude | agents | all (default all).",
  });

  host = Option.String("--host", {
    description: "Base directory to install under (default: current directory).",
  });

  dryRun = Option.Boolean("--dry-run", false, {
    description: "Show what would change without writing any files.",
  });

  override async execute(): Promise<number> {
    if (!SCOPES.includes(this.scope as Scope)) {
      this.context.stderr.write(
        `error: invalid --scope '${this.scope}' (expected: ${SCOPES.join(" | ")})\n`,
      );
      return 1;
    }

    const { installSkills } = await import("../../skills/index.ts");
    let results: Awaited<ReturnType<typeof installSkills>>;
    try {
      results = installSkills({
        baseDir: this.host,
        scope: this.scope as Scope,
        dryRun: this.dryRun,
      });
    } catch (cause) {
      this.context.stderr.write(
        `error: ${cause instanceof Error ? cause.message : String(cause)}\n`,
      );
      return 1;
    }

    const verb = this.dryRun ? "would write" : "wrote";
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    for (const r of results) {
      if (r.action === "unchanged") {
        unchanged++;
        continue;
      }
      if (r.action === "created") created++;
      else updated++;
      this.context.stdout.write(
        `${verb} ${r.action === "created" ? "new" : "updated"}: ${r.mirrorPath}\n`,
      );
    }
    this.context.stdout.write(
      `${this.dryRun ? "Dry run: " : ""}${created} created, ${updated} updated, ${unchanged} unchanged (scope=${this.scope}).\n`,
    );
    return 0;
  }
}

export class SkillsListCommand extends Command {
  static override paths = [["skills", "list"]];

  static override usage = Command.Usage({
    category: "Skills",
    description: "List bundled assistant skills and their installed status.",
    details: `
      Lists the bundled assistant skills (ADR-0008) and, per host dir, whether
      each is installed, missing, or modified relative to the SSOT
      (docs/skills/<name>/SKILL.md).
    `,
    examples: [
      ["List bundled skills and status", "suasor skills list"],
      ["Status for Claude Code only", "suasor skills list --scope claude"],
      ["Machine-readable output", "suasor skills list --json"],
    ],
  });

  scope = Option.String("--scope", "all", {
    description: "Status target: claude | agents | all (default all).",
  });

  host = Option.String("--host", {
    description: "Base directory to inspect (default: current directory).",
  });

  json = Option.Boolean("--json", false, {
    description: "Emit the status list as JSON.",
  });

  override async execute(): Promise<number> {
    if (!SCOPES.includes(this.scope as Scope)) {
      this.context.stderr.write(
        `error: invalid --scope '${this.scope}' (expected: ${SCOPES.join(" | ")})\n`,
      );
      return 1;
    }

    const { skillStatuses } = await import("../../skills/index.ts");
    let statuses: Awaited<ReturnType<typeof skillStatuses>>;
    try {
      statuses = skillStatuses({ baseDir: this.host, scope: this.scope as Scope });
    } catch (cause) {
      this.context.stderr.write(
        `error: ${cause instanceof Error ? cause.message : String(cause)}\n`,
      );
      return 1;
    }

    if (this.json) {
      this.context.stdout.write(`${JSON.stringify(statuses)}\n`);
      return 0;
    }

    for (const s of statuses) {
      this.context.stdout.write(`${s.state.padEnd(9)} ${s.host.padEnd(7)} ${s.name}\n`);
    }
    const installed = statuses.filter((s) => s.state === "installed").length;
    const missing = statuses.filter((s) => s.state === "missing").length;
    const modified = statuses.filter((s) => s.state === "modified").length;
    this.context.stdout.write(
      `${installed} installed, ${missing} missing, ${modified} modified (scope=${this.scope}).\n`,
    );
    return 0;
  }
}
