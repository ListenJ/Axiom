/**
 * Skills System - Index
 *
 * Central export for all skill-related modules.
 */

export { type PromptTemplate, type SkillDefinition, type SkillFile, type PromptMatchResult } from "./types.js";
export {
  loadSkillsFromDirectories,
  loadSkillFile,
  saveSkillFile,
  createSkillFileBoilerplate,
  watchSkillDirectories,
  clearSkillCache,
  type SkillLoaderOptions,
  type LoadedSkills,
} from "./skill-loader.js";
export {
  SkillRegistry,
  getSkillRegistry,
  resetSkillRegistry,
  type SkillMatch,
  type SkillExecuteResult,
  type SkillRegistryOptions,
} from "./skill-registry.js";
