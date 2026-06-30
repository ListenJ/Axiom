/**
 * SQLiteMemory shim — lazy accessor.
 *
 * Uses createLazySingleton to break circular imports and allow test mocking.
 */
import { createRequire } from "module";
import type { SQLiteMemory } from "../../memory/sqlite-memory.js";
import { createLazySingleton } from "../../utils/lazy-singleton.js";

const _require = createRequire(import.meta.url);

const singleton = createLazySingleton<SQLiteMemory>(
  () => (_require("../../memory/sqlite-memory.js") as { getSqliteMemory: () => SQLiteMemory }).getSqliteMemory()
);

export const getSqliteMemory = singleton.get.bind(singleton);
export const setSqliteMemoryForTest = singleton.setForTest.bind(singleton);

/**
 * Type re-export for the subset of methods we actually call.
 * MemoryCurator invokes upsertNote, search, close, and listByCategory.
 */
export type SQLiteMemorySubset = Pick<SQLiteMemory, "upsertNote" | "search" | "close" | "listByCategory">;
