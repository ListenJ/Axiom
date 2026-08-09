import { MemoryArchiver } from "../../memory/archiver.js";
import { MemoryDistiller } from "../../memory/distiller.js";
import { getSqliteMemory as createSqliteMemory, type SQLiteMemory } from "../../memory/sqlite-memory.js";
import { promptEngineer, type PromptEngineer } from "../../agents/prompt-engineer.js";
import { getSkillRegistry as createSkillRegistry, type SkillRegistry } from "../../skills/skill-registry.js";
import { createLazySingleton } from "../../utils/lazy-singleton.js";

const archiver = createLazySingleton<MemoryArchiver>(() => new MemoryArchiver());
const distiller = createLazySingleton<MemoryDistiller>(() => new MemoryDistiller());
const sqlite = createLazySingleton<SQLiteMemory>(() => createSqliteMemory());
const engineer = createLazySingleton<PromptEngineer>(() => promptEngineer);
const registry = createLazySingleton<SkillRegistry>(() => createSkillRegistry());

export const getGlobalMemoryArchiver = archiver.get.bind(archiver);
export const setMemoryArchiverForTest = archiver.setForTest.bind(archiver);
export const getGlobalMemoryDistiller = distiller.get.bind(distiller);
export const setMemoryDistillerForTest = distiller.setForTest.bind(distiller);
export const getSqliteMemory = sqlite.get.bind(sqlite);
export const setSqliteMemoryForTest = sqlite.setForTest.bind(sqlite);
export const getPromptEngineer = engineer.get.bind(engineer);
export const setPromptEngineerForTest = engineer.setForTest.bind(engineer);
export const getSkillRegistry = registry.get.bind(registry);
export const setSkillRegistryForTest = registry.setForTest.bind(registry);

export type MemoryArchiverSubset = Pick<MemoryArchiver, "archive" | "archiveNote" | "stats">;
export type MemoryDistillerSubset = Pick<MemoryDistiller, "distillConversation" | "distillWebClip" | "distillManual">;
export type SQLiteMemorySubset = Pick<SQLiteMemory, "upsertNote" | "search" | "listByCategory" | "deleteNote" | "close">;
export type PromptEngineerSubset = Pick<PromptEngineer, "generateSkillWithHermes">;
export type SkillRegistrySubset = Pick<SkillRegistry, "register" | "list" | "match" | "execute" | "reload">;