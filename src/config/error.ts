/**
 * ConfigError — thrown on invalid configuration so startup fails fast
 * (docs/design/config.md). Carries the underlying Zod issues when available.
 */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
  /** Human-readable per-field issues (path: message), when sourced from Zod. */
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    // Zod can report the same path/message pair more than once (e.g. via
    // unions); dedupe so the rendered error lists each finding once (#560).
    const unique = [...new Set(issues)];
    super(unique.length > 0 ? `${message}\n  ${unique.join("\n  ")}` : message);
    this.issues = unique;
  }
}
