import type { MemoryArchiver } from "../../memory/archiver.js";
import type { MemoryDistiller } from "../../memory/distiller.js";
import type { SQLiteMemory } from "../../memory/sqlite-memory.js";
import type { PromptEngineer } from "../../agents/prompt-engineer.js";
import type { SkillRegistry } from "../../skills/skill-registry.js";
import { createLazySingleton } from "../../utils/lazy-singleton.js";

const archiver = createLazySingleton<MemoryArchiver>(
  () => new (require("../../memory/archiver.js").MemoryArchiver)()
);
const distiller = createLazySingleton<MemoryDistiller>(
  () => new (require("../../memory/distiller.js").MemoryDistiller)()
);
const sqlite = createLazySingleton<SQLiteMemory>(
  () => (require("../../memory/sqlite-memory.js") as { getSqliteMemory: () => SQLiteMemory }).getSqliteMemory()
);
const promptEngineer = createLazySingleton<PromptEngineer>(
  () => (require("../../agents/prompt-engineer.js") as { promptEngineer: PromptEngineer }).promptEngineer
);
const skillRegistry = createLazySingleton<SkillRegistry>(
  () => (require("../../skills/skill-registry.js") as { getSkillRegistry: () => SkillRegistry }).getSkillRegistry()
);

export const getGlobalMemoryArchiver = archiver.get.bind(archiver);
export const setMemoryArchiverForTest = archiver.setForTest.bind(archiver);
export const getGlobalMemoryDistiller = distiller.get.bind(distiller);
export const setMemoryDistillerForTest = distiller.setForTest.bind(distiller);
export const getSqliteMemory = sqlite.get.bind(sqlite);
export const setSqliteMemoryForTest = sqlite.setForTest.bind(sqlite);
export const getPromptEngineer = promptEngineer.get.bind(promptEngineer);
export const setPromptEngineerForTest = promptEngineer.setForTest.bind(promptEngineer);
export const getSkillRegistry = skillRegistry.get.bind(skillRegistry);
export const setSkillRegistryForTest = skillRegistry.setForTest.bind(skillRegistry);

export type MemoryArchiverSubset = Pick<MemoryArchiver, "archive" | "stats">;
export type MemoryDistillerSubset = Pick<MemoryDistiller, "distillConversation" | "distillWebClip" | "distillManual">;
export type SQLiteMemorySubset = Pick<SQLiteMemory, "upsertNote" | "search" | "listByCategory" | "close">;
export type PromptEngineerSubset = Pick<PromptEngineer, "generateSkillWithHermes">;
export type SkillRegistrySubset = Pick<SkillRegistry, "register" | "list" | "match" | "execute" | "reload">;
