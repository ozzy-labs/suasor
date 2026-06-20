/**
 * Skills module: bundled assistant-skill catalog + install / status / drift
 * (ADR-0008) + frontmatter schema (ADR-0032), docs/design/cli.md.
 */
export {
  type BundledSkill,
  HOSTS,
  type Host,
  listBundledSkills,
  resolveSkillsSource,
  SCOPES,
  type Scope,
  SKILL_FILE,
  scopeHosts,
} from "./catalog.ts";
export {
  extractFrontmatterBlock,
  loadSkillFrontmatter,
  loadSkillInfos,
  parseFrontmatter,
  SKILL_CATEGORIES,
  type SkillCategory,
  SkillFrontmatter,
  SkillFrontmatterError,
  type SkillInfo,
  skillMatchesQuery,
  validateFrontmatter,
} from "./frontmatter.ts";
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
