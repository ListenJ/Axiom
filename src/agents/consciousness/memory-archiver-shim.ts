/**
 * MemoryArchiver shim — lazy accessor.
 *
 * Uses createLazySingleton to break circular imports and allow test mocking.
 *
 * DO NOT add business logic here. Just import + memoize.
 */
import type { MemoryArchiver } from "../../memory/archiver.js";
import { createLazySingleton } from "../../utils/lazy-singleton.js";

const singleton = createLazySingleton<MemoryArchiver>(
  () => new (require("../../memory/archiver.js").MemoryArchiver)()
);

export const getGlobalMemoryArchiver = singleton.get.bind(singleton);
export const setMemoryArchiverForTest = singleton.setForTest.bind(singleton);

/**
 * Type re-export for the small subset of methods we actually call.
 * MemoryCurator only ever invokes archive() / stats().
 */
export type MemoryArchiverSubset = Pick<MemoryArchiver, "archive" | "stats">;
