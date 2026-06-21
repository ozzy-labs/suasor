/**
 * `suasor validate-config [--fix]` — structural validation of config.toml with
 * optional safe auto-fix (Issue #280).
 *
 * `doctor` checks whether the environment is *wired* (DB present, credentials
 * set); this verb checks whether the config *file itself* is well-formed. It
 * re-runs the loader's validation (schema + strict per-connector slices,
 * ADR-0007) but, instead of failing fast on the first issue, collects and
 * classifies every finding: missing-required / invalid-value / unknown-key
 * (typo) / dangling-reference.
 *
 * With --fix it applies the conservative, removal-only repair policy (drop
 * unknown/typo keys; drop dangling local roots) via surgical TOML text edits
 * that preserve comments and formatting. It never invents a value, so
 * missing-required / invalid-value findings are reported but never auto-fixed
 * (HITL, ADR-0004). Secrets are never read or written (tokens live in the
 * keychain; config carries none — NFR-PRV-4); the file body is not echoed.
 *
 * Exit code: 1 when unfixed findings remain (so CI can gate on it), else 0.
 *
 * Lazy-import discipline (NFR-PRF-1): the config dir resolver, validator, and
 * TOML editor are imported inside `execute`; only clipanion is eager.
 */
import { Command, Option } from "clipanion";

export class ValidateConfigCommand extends Command {
  static override paths = [["validate-config"]];

  static override usage = Command.Usage({
    category: "Maintenance",
    description:
      "Validate config.toml (missing/invalid/dangling/typo); --fix applies safe repairs.",
    details: `
      Validates config.toml structurally with the same rules the loader uses
      (schema + strict per-connector slices, ADR-0007), collecting *every*
      finding instead of failing on the first. Findings are classified:

        missing-required    a required key is absent
        invalid-value       a value violates its type / enum / range / regex
        unknown-key         a key not in the connector schema (a typo)
        dangling-reference  a path setting points at something that doesn't exist

      Complements \`doctor\` (which checks whether things are *wired*). With
      --fix, the safe, removal-only repairs are applied (drop unknown/typo keys;
      drop dangling local roots) via surgical TOML edits that keep your comments
      and formatting. It never invents a value, so missing/invalid findings are
      reported but never auto-fixed (HITL, ADR-0004). Exits 1 when unfixed
      findings remain.
    `,
    examples: [
      ["Validate the config", "suasor validate-config"],
      ["Apply safe repairs", "suasor validate-config --fix"],
    ],
  });

  fix = Option.Boolean("--fix", false, {
    description: "Apply the safe, removal-only repairs (unknown keys, dangling local roots).",
  });

  override async execute(): Promise<number> {
    const [{ resolveConfigDir }, { validateConfig }, tomlEdit, { join }, fs] = await Promise.all([
      import("../../config/index.ts"),
      import("../../config/validate.ts"),
      import("../../config/toml-edit.ts"),
      import("node:path"),
      import("node:fs/promises"),
    ]);

    const configDir = resolveConfigDir();
    const configPath = join(configDir, "config.toml");

    let text: string;
    try {
      text = await fs.readFile(configPath, "utf8");
    } catch {
      this.context.stderr.write(`error: no config.toml at ${configPath} (run \`suasor init\`)\n`);
      return 1;
    }

    let raw: Record<string, unknown>;
    try {
      const parsed = Bun.TOML.parse(text);
      raw = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch (err) {
      // A syntactically broken TOML file is the most fundamental invalid-value:
      // we cannot parse a tree to classify, so report and stop (no fix possible).
      this.context.stderr.write(
        `error: config.toml is not valid TOML: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 1;
    }

    const { findings } = await validateConfig(raw, false);

    if (findings.length === 0) {
      this.context.stdout.write(`config is valid: ${configPath}\n`);
      return 0;
    }

    // Report all findings grouped by kind for a scannable summary.
    this.context.stdout.write(`validate-config: ${configPath}\n`);
    for (const f of findings) {
      const tag = this.fix && f.fixable ? "FIX " : f.fixable ? "fixable" : "------";
      this.context.stdout.write(`  [${f.kind}] ${tag} ${f.path}: ${f.message}\n`);
    }

    if (!this.fix) {
      const fixableCount = findings.filter((f) => f.fixable).length;
      this.context.stdout.write(
        `\n${findings.length} finding(s)` +
          (fixableCount > 0 ? `, ${fixableCount} fixable — re-run with --fix\n` : "\n"),
      );
      return 1;
    }

    // --fix: apply removal-only repairs via surgical TOML text edits so comments
    // and formatting survive. We re-derive the precise removals from the findings
    // rather than re-serializing the validated tree.
    let edited = text;
    const applied: string[] = [];
    for (const f of findings) {
      if (!f.fixable) continue;
      if (f.kind === "unknown-key") {
        const r = tomlEdit.removeKeyLine(edited, f.path);
        if (r.changed) {
          edited = r.text;
          applied.push(f.path);
        }
      } else if (
        f.kind === "dangling-reference" &&
        f.path.startsWith("connectors.local.roots.") &&
        f.value !== undefined
      ) {
        // The exact root string to drop is carried on the finding (not re-parsed
        // from the message), so values containing ": " are handled correctly.
        // Element path for the array is the dotted prefix without the index.
        const arrayPath = f.path.replace(/\.\d+$/, "");
        const r = tomlEdit.removeArrayElement(edited, arrayPath, f.value);
        if (r.changed) {
          edited = r.text;
          applied.push(f.path);
        }
      }
    }

    if (applied.length === 0) {
      this.context.stdout.write("\nno safe repairs to apply.\n");
      return 1; // findings remain
    }

    // Write the repaired text, then re-validate to confirm the edits are sound.
    await fs.writeFile(configPath, edited, "utf8");
    let reparsed: Record<string, unknown> = {};
    try {
      const p = Bun.TOML.parse(edited);
      reparsed = p && typeof p === "object" ? (p as Record<string, unknown>) : {};
    } catch (err) {
      // Should not happen (removals only), but never leave a broken file silently.
      await fs.writeFile(configPath, text, "utf8");
      this.context.stderr.write(
        `error: repair produced invalid TOML; reverted: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 1;
    }
    const after = await validateConfig(reparsed, false);

    this.context.stdout.write(`\napplied ${applied.length} repair(s):\n`);
    for (const p of applied) this.context.stdout.write(`  - ${p}\n`);

    const remaining = after.findings;
    if (remaining.length > 0) {
      this.context.stdout.write(
        `\n${remaining.length} finding(s) remain (not auto-fixable — edit manually):\n`,
      );
      for (const f of remaining) {
        this.context.stdout.write(`  [${f.kind}] ${f.path}: ${f.message}\n`);
      }
      return 1;
    }
    this.context.stdout.write("\nconfig is now valid.\n");
    return 0;
  }
}
