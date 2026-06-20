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
import { standaloneGate } from "../build-target.ts";

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
    const gate = standaloneGate(
      "'skills install' (the bundled docs/skills are not shipped in the binary)",
    );
    if (!gate.ok) {
      this.context.stderr.write(gate.message);
      return 1;
    }

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

      --format=detailed adds each skill's category and read/write boundary
      (frontmatter, ADR-0032). The default --format=compact preserves the
      original status-only output.
    `,
    examples: [
      ["List bundled skills and status", "suasor skills list"],
      ["Status for Claude Code only", "suasor skills list --scope claude"],
      ["Show category + read/write boundary", "suasor skills list --format=detailed"],
      ["Machine-readable output", "suasor skills list --json"],
    ],
  });

  scope = Option.String("--scope", "all", {
    description: "Status target: claude | agents | all (default all).",
  });

  host = Option.String("--host", {
    description: "Base directory to inspect (default: current directory).",
  });

  format = Option.String("--format", "compact", {
    description: "Output format: compact | detailed (default compact).",
  });

  json = Option.Boolean("--json", false, {
    description: "Emit the status list as JSON.",
  });

  override async execute(): Promise<number> {
    const gate = standaloneGate(
      "'skills list' (the bundled docs/skills are not shipped in the binary)",
    );
    if (!gate.ok) {
      this.context.stderr.write(gate.message);
      return 1;
    }

    if (!SCOPES.includes(this.scope as Scope)) {
      this.context.stderr.write(
        `error: invalid --scope '${this.scope}' (expected: ${SCOPES.join(" | ")})\n`,
      );
      return 1;
    }

    const FORMATS = ["compact", "detailed"] as const;
    if (!FORMATS.includes(this.format as (typeof FORMATS)[number])) {
      this.context.stderr.write(
        `error: invalid --format '${this.format}' (expected: ${FORMATS.join(" | ")})\n`,
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

    // --json keeps the established SkillStatus[] shape unchanged (ADR-0032 §(d)).
    if (this.json) {
      this.context.stdout.write(`${JSON.stringify(statuses)}\n`);
      return 0;
    }

    if (this.format === "detailed") {
      // Augment status rows with frontmatter category + read/write boundary.
      const { listBundledSkills, loadSkillFrontmatter } = await import("../../skills/index.ts");
      const meta = new Map<string, { category: string; rw: string }>();
      try {
        for (const skill of listBundledSkills()) {
          const fm = loadSkillFrontmatter(skill).frontmatter;
          meta.set(skill.name, {
            category: fm.category ?? "-",
            rw: fm.readOnly === false ? "write" : fm.readOnly === true ? "read" : "-",
          });
        }
      } catch (cause) {
        this.context.stderr.write(
          `error: ${cause instanceof Error ? cause.message : String(cause)}\n`,
        );
        return 1;
      }
      for (const s of statuses) {
        const m = meta.get(s.name) ?? { category: "-", rw: "-" };
        this.context.stdout.write(
          `${s.state.padEnd(9)} ${s.host.padEnd(7)} ${m.rw.padEnd(5)} ${m.category.padEnd(11)} ${s.name}\n`,
        );
      }
    } else {
      for (const s of statuses) {
        this.context.stdout.write(`${s.state.padEnd(9)} ${s.host.padEnd(7)} ${s.name}\n`);
      }
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

export class SkillsSearchCommand extends Command {
  static override paths = [["skills", "search"]];

  static override usage = Command.Usage({
    category: "Skills",
    description: "Search bundled assistant skills by keyword.",
    details: `
      Case-insensitive substring search over each bundled skill's name,
      description, category and trigger phrases (frontmatter, ADR-0032). Prints
      matches with their read/write boundary and category.
    `,
    examples: [
      ["Find skills about meetings", "suasor skills search meeting"],
      ["Find skills by trigger phrase", "suasor skills search 引き継ぎ"],
      ["Machine-readable output", "suasor skills search brief --json"],
    ],
  });

  query = Option.String({ required: true });

  json = Option.Boolean("--json", false, {
    description: "Emit matches as JSON.",
  });

  override async execute(): Promise<number> {
    const gate = standaloneGate(
      "'skills search' (the bundled docs/skills are not shipped in the binary)",
    );
    if (!gate.ok) {
      this.context.stderr.write(gate.message);
      return 1;
    }

    const { listBundledSkills, loadSkillInfos, skillMatchesQuery } = await import(
      "../../skills/index.ts"
    );
    let matches: Awaited<ReturnType<typeof loadSkillInfos>>;
    try {
      const infos = loadSkillInfos(listBundledSkills());
      matches = infos.filter((info) => skillMatchesQuery(info, this.query));
    } catch (cause) {
      this.context.stderr.write(
        `error: ${cause instanceof Error ? cause.message : String(cause)}\n`,
      );
      return 1;
    }

    if (this.json) {
      this.context.stdout.write(
        `${JSON.stringify(matches.map((m) => ({ ...m.frontmatter, name: m.name })))}\n`,
      );
      return 0;
    }

    if (matches.length === 0) {
      this.context.stdout.write(`No skills match '${this.query}'.\n`);
      return 0;
    }
    for (const m of matches) {
      const fm = m.frontmatter;
      const rw = fm.readOnly === false ? "write" : "read";
      this.context.stdout.write(`${rw.padEnd(5)} ${(fm.category ?? "-").padEnd(11)} ${m.name}\n`);
    }
    this.context.stdout.write(`${matches.length} match(es) for '${this.query}'.\n`);
    return 0;
  }
}

export class SkillsInfoCommand extends Command {
  static override paths = [["skills", "info"]];

  static override usage = Command.Usage({
    category: "Skills",
    description: "Show details for one bundled assistant skill.",
    details: `
      Prints a single skill's category, read/write boundary, trigger phrases,
      paired skills, MCP tools and description (frontmatter, ADR-0032).
    `,
    examples: [
      ["Show the next-actions skill", "suasor skills info next-actions"],
      ["Machine-readable output", "suasor skills info research --json"],
    ],
  });

  name = Option.String({ required: true });

  json = Option.Boolean("--json", false, {
    description: "Emit the skill detail as JSON.",
  });

  override async execute(): Promise<number> {
    const gate = standaloneGate(
      "'skills info' (the bundled docs/skills are not shipped in the binary)",
    );
    if (!gate.ok) {
      this.context.stderr.write(gate.message);
      return 1;
    }

    const { listBundledSkills, loadSkillFrontmatter } = await import("../../skills/index.ts");
    let skill: ReturnType<typeof listBundledSkills>[number] | undefined;
    let fm: Awaited<ReturnType<typeof loadSkillFrontmatter>>["frontmatter"];
    try {
      skill = listBundledSkills().find((s) => s.name === this.name);
      if (skill === undefined) {
        this.context.stderr.write(`error: unknown skill '${this.name}'\n`);
        return 1;
      }
      fm = loadSkillFrontmatter(skill).frontmatter;
    } catch (cause) {
      this.context.stderr.write(
        `error: ${cause instanceof Error ? cause.message : String(cause)}\n`,
      );
      return 1;
    }

    if (this.json) {
      this.context.stdout.write(`${JSON.stringify({ ...fm, name: this.name })}\n`);
      return 0;
    }

    const w = this.context.stdout;
    w.write(`name:        ${this.name}\n`);
    w.write(`category:    ${fm.category ?? "-"}\n`);
    w.write(`boundary:    ${fm.readOnly === false ? "write (HITL)" : "read (autonomous)"}\n`);
    if (fm.triggers && fm.triggers.length > 0) {
      w.write(`triggers:\n`);
      for (const t of fm.triggers) w.write(`  - ${t}\n`);
    }
    if (fm.pairs && fm.pairs.length > 0) {
      w.write(`pairs:       ${fm.pairs.join(", ")}\n`);
    }
    if (fm.mcp_tools_read && fm.mcp_tools_read.length > 0) {
      w.write(`mcp (read):  ${fm.mcp_tools_read.join(", ")}\n`);
    }
    if (fm.mcp_tools_write && fm.mcp_tools_write.length > 0) {
      w.write(`mcp (write): ${fm.mcp_tools_write.join(", ")}\n`);
    }
    w.write(`description: ${fm.description}\n`);
    return 0;
  }
}
