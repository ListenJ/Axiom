/**
 * PromptEngineer shim — lazy accessor.
 *
 * Uses createLazySingleton to break circular imports and allow test mocking.
 *
 * DO NOT add business logic here. Just import + memoize.
 */
import type { PromptEngineer } from "../../agents/prompt-engineer.js";
import type { SkillDefinition } from "../../skills/types.js";
import { createLazySingleton } from "../../utils/lazy-singleton.js";

const singleton = createLazySingleton<PromptEngineer>(
  () => (require("../../agents/prompt-engineer.js") as { promptEngineer: PromptEngineer }).promptEngineer
);

export const getPromptEngineer = singleton.get.bind(singleton);
export const setPromptEngineerForTest = singleton.setForTest.bind(singleton);

/**
 * Type re-export for the small subset of methods we actually call.
 * SkillPromoter only ever calls generateSkillWithHermes.
 */
export type PromptEngineerSubset = Pick<PromptEngineer, "generateSkillWithHermes">;

/** Compile-time guard: ensure SkillDefinition stays compatible. */
export type _Assert = SkillDefinition;
