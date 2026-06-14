/**
 * Skills module: bundled assistant-skill catalog + install / status / drift
 * (ADR-0008, docs/design/cli.md).
 */
export {
  type BundledSkill,
  type Host,
  HOSTS,
  listBundledSkills,
  resolveSkillsSource,
  type Scope,
  SCOPES,
  SKILL_FILE,
  scopeHosts,
} from "./catalog.ts";
export {
  detectDrift,
  type InstallAction,
  type InstallOptions,
  type InstallResult,
  installSkills,
  mirrorPath,
  type SkillState,
  type SkillStatus,
  skillStatuses,
} from "./install.ts";
