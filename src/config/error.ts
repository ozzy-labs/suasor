/**
 * ConfigError — thrown on invalid configuration so startup fails fast
 * (docs/design/config.md). Carries the underlying Zod issues when available.
 */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
  /** Human-readable per-field issues (path: message), when sourced from Zod. */
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(issues.length > 0 ? `${message}\n  ${issues.join("\n  ")}` : message);
    this.issues = issues;
  }
}
