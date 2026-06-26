/**
 * SQLiteMemory shim — lazy accessor.
 *
 * Uses createLazySingleton to break circular imports and allow test mocking.
 */
import type { SQLiteMemory } from "../../memory/sqlite-memory.js";
import { createLazySingleton } from "../../utils/lazy-singleton.js";

const singleton = createLazySingleton<SQLiteMemory>(
  () => (require("../../memory/sqlite-memory.js") as { getSqliteMemory: () => SQLiteMemory }).getSqliteMemory()
);

export const getSqliteMemory = singleton.get.bind(singleton);
export const setSqliteMemoryForTest = singleton.setForTest.bind(singleton);

/**
 * Type re-export for the small subset of methods we actually call.
 * MemoryCurator only ever invokes upsertNote / search / close.
 */
export type SQLiteMemorySubset = Pick<SQLiteMemory, "upsertNote" | "search" | "close">;
