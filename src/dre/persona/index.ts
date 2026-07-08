/**
 * Persona System — barrel export
 *
 * Persona = Constraints + MentalModels + Capabilities + PromptTemplate
 * 替代原来的 AgentHarness 子类。
 */

export { PersonaLoader } from "./loader.js";
export type { PersonaLoaderConfig } from "./loader.js";
export { PromptTemplateStore, createDefaultPromptStore, DEFAULT_PROMPT_TEMPLATES } from "./prompt-store.js";
export type { PromptTemplate, TemplateVariables } from "./prompt-store.js";
export {
  SECURITY_PERSONA_CONFIG,
  CREATIVE_PERSONA_CONFIG,
  GENERAL_PERSONA_CONFIG,
} from "./types.js";
export type {
  PersonaMode,
  PersonaConfig,
  LoadedPersona,
  PersonaContext,
} from "./types.js";
