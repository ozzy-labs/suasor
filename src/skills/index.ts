/**
 * Skills module: bundled assistant-skill catalog + install / status / drift
 * (ADR-0008) + frontmatter schema (ADR-0032), docs/design/cli.md.
 */
export {
  type BundledSkill,
  embeddedSourceLabel,
  HOSTS,
  type Host,
  listBundledSkills,
  listEmbeddedSkills,
  readSkillSource,
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
  orphanStatuses,
  type PruneResult,
  pruneSkills,
  RETIRED_SKILLS,
  readStamp,
  type SkillState,
  type SkillStatus,
  type SkillsStamp,
  STAMP_FILE,
  skillStatuses,
  staleMirrorWarning,
  stampPath,
} from "./install.ts";
