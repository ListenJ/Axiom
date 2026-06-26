/**
 * SkillRegistry shim — lazy accessor.
 *
 * Uses createLazySingleton to break circular imports and allow test mocking.
 */
import type { SkillRegistry } from "../../skills/skill-registry.js";
import type { SkillDefinition } from "../../skills/types.js";
import { createLazySingleton } from "../../utils/lazy-singleton.js";

const singleton = createLazySingleton<SkillRegistry>(
  () => (require("../../skills/skill-registry.js") as { getSkillRegistry: () => SkillRegistry }).getSkillRegistry()
);

export const getSkillRegistry = singleton.get.bind(singleton);
export const setSkillRegistryForTest = singleton.setForTest.bind(singleton);

export type SkillRegistrySubset = Pick<SkillRegistry, "register" | "list" | "match" | "execute" | "reload">;
export type _Assert = SkillDefinition;
